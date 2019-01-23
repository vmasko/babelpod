var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var airtunes = require('airtunes');
var spawn = require('child_process').spawn;
var util = require('util');
var stream = require('stream');
var mdns = require('mdns-js');
var blue = require("bluetoothctl");
var fs = require('fs');
var { exec } = require('child_process');

var defaultInputId = "plughw:1,0";
var defaultOutputId = "plughw:0,1";
var isDefaultInputEnabled = true;
var isDefaultOutputEnabled = true;

var shouldSwitchDefaultInput = true;
var shouldSwitchDefaultOutput = true;

// Create ToVoid and FromVoid streams so we always have somewhere to send to and from.
util.inherits(ToVoid, stream.Writable);
function ToVoid () {
  if (!(this instanceof ToVoid)) return new ToVoid();
  stream.Writable.call(this);
}
ToVoid.prototype._write = function (chunk, encoding, cb) {
}

util.inherits(FromVoid, stream.Readable);
function FromVoid () {
  if (!(this instanceof FromVoid)) return new FromVoid();
  stream.Readable.call(this);
}
FromVoid.prototype._read = function (chunk, encoding, cb) {
}

var currentInput = "void";
var currentOutput = "void";
var inputStream = new FromVoid();
var outputStream = new ToVoid();
var airplayDevice = null;
var arecordInstance = null;
var aplayInstance = null;
var volume = 50;
var availableOutputs = [];
var availablePcmOutputs = []
var availableAirplayOutputs = [];
var availableInputs = [];
var availableBluetoothInputs = [];
var availablePcmInputs = [];

// Watch for new PCM input/output devices every 10 seconds
var pcmDeviceSearchLoop = setInterval(function(){
  try {
    var pcmDevicesString = fs.readFileSync('/proc/asound/pcm', 'utf8');
  } catch (e) {
    console.log("audio input/output pcm devices could not be found");
    return;
  }
  var pcmDevicesArray = pcmDevicesString.split("\n").filter(line => line!="");
  var pcmDevices = pcmDevicesArray.map(device => {var splitDev = device.split(":");return {id: "plughw:"+splitDev[0].split("-").map(num => parseInt(num, 10)).join(","), name:splitDev[2].trim(), output: splitDev.some(part => part.includes("playback")), input: splitDev.some(part => part.includes("capture"))}});
  availablePcmOutputs = pcmDevices.filter(dev => dev.output);
  availablePcmInputs = pcmDevices.filter(dev => dev.input);
  updateAllInputs();
  updateAllOutputs();
}, 10000);

// set airplay volume every 60 seconds to keep connection alive
var airplayKeepAliveSetVolumeLoop = setInterval(function(){
  if (airplayDevice !== null) {
    airplayDevice.setVolume(volume, function(){
      console.log('set airplay volume to keep connection alive');
    });
  }
}, 60000);

// Watch for new Bluetooth devices
blue.Bluetooth();
blue.on(blue.bluetoothEvents.Device, function (devices) {
  console.log('devices:' + JSON.stringify(devices,null,2));
  availableBluetoothInputs = [];
  for (var device of blue.devices){
    availableBluetoothInputs.push({
      'name': 'Bluetooth: '+device.name,
      'id': 'bluealsa:HCI=hci0,DEV='+device.mac+',PROFILE=a2dp,DELAY=10000'
    });
  }
  updateAllInputs();
})

function updateAllInputs(){
  var defaultInputs = [
    {
      'name': 'None',
      'id': 'void'
    }
  ];
  availableInputs = defaultInputs.concat(availablePcmInputs, availableBluetoothInputs);
  // todo only emit if updated
  if (isDefaultInputEnabled === true) {
    var isInputAvailable = availableInputs
      .map(function(input) { return input.id; })
      .indexOf(defaultInputId);

    if (shouldSwitchDefaultInput && isInputAvailable > -1) {
      switchInput(defaultInputId);
      shouldSwitchDefaultInput = false;
    }
  }

  io.emit('available_inputs', availableInputs);
}
updateAllInputs();

function updateAllOutputs(){
  var defaultOutputs = [
    {
      'name': 'None',
      'id': 'void',
      'type': 'void'
    }
  ];
  availableOutputs = defaultOutputs.concat(availablePcmOutputs, availableAirplayOutputs);
  // todo only emit if updated
  if (isDefaultOutputEnabled === true) {
    var isOutputAvailable = availableOutputs
      .map(function(output) { return output.id; })
      .indexOf(defaultOutputId);

    if (shouldSwitchDefaultOutput && isOutputAvailable > -1) {
      switchOutput(defaultOutputId);
      shouldSwitchDefaultOutput = false;
    }
  }

  io.emit('available_outputs', availableOutputs);
}
updateAllOutputs();

var browser = mdns.createBrowser(mdns.tcp('raop'));
browser.on('ready', function () {
    browser.discover();
});
browser.on('update', function (data) {
  // console.log("service up: ", data);
  // console.log(service.addresses);
  // console.log(data.fullname);
  if (data.fullname){
    var splitName = /([^@]+)@(.*)\._raop\._tcp\.local/.exec(data.fullname);
    if (splitName != null && splitName.length > 1){
      // TODO skip if already in list
      availableAirplayOutputs.push({
        'name': 'AirPlay: ' + splitName[2],
        'id': 'airplay_'+data.addresses[0]+'_'+data.port,
        'type': 'airplay'
        // 'address': service.addresses[1],
        // 'port': service.port,
        // 'host': service.host
      });
      updateAllOutputs();
    }
  }
  // console.log(airplayDevices);
});
// browser.on('serviceDown', function(service) {
//   console.log("service down: ", service);
// });

function cleanupCurrentInput(){
  inputStream.unpipe(outputStream);
  if (arecordInstance !== null){
    arecordInstance.kill();
  }
}

function cleanupCurrentOutput(){
  console.log("inputStream", inputStream);
  console.log("outputStream", outputStream);
  inputStream.unpipe(outputStream);
  if (airplayDevice !== null) {
    airplayDevice.stop(function(){
      console.log('stopped airplay device');
    })
    airplayDevice = null;
  }
  if (aplayInstance !== null){
    aplayInstance.kill();
    aplayInstance = null;
  }
}

function switchInput(msg) {
  console.log('switch_input: ' + msg);
  currentInput = msg;
  cleanupCurrentInput();
  if (msg === "void"){
    inputStream = new FromVoid();
    inputStream.pipe(outputStream);
  }
  if (msg !== "void"){
    arecordInstance = spawn("arecord", [
      '-D', msg,
      '-c', "2",
      '-f', "S16_LE",
      '-r', "44100"
    ]);
    inputStream = arecordInstance.stdout;

    inputStream.pipe(outputStream);
  }
}

function switchOutput(msg) {
  console.log('switch_output: ' + msg);
  currentOutput = msg;
  cleanupCurrentOutput();
  if (msg.startsWith("airplay")){
    var split = msg.split("_");
    var host = split[1];
    var port = split[2];
    console.log('adding device: ' + host + ':' + port);
    airplayDevice = airtunes.add(host, {port: port, volume: volume});
    airplayDevice.on('status', function(status) {
      console.log('airplay status: ' + status);
      if(status === 'ready'){
        outputStream = airtunes;
        inputStream.pipe(outputStream);
      }
    });
  }
  if (msg.startsWith("plughw:")){
    aplayInstance = spawn("aplay", [
      '-D', msg,
      '-c', "2",
      '-f', "S16_LE",
      '-r', "44100"
    ]);

    outputStream = aplayInstance.stdin;
    inputStream.pipe(outputStream);
  }
  if (msg === "void"){
    outputStream = new ToVoid();
    inputStream.pipe(outputStream);
  }
}

app.get('/', function(req, res){
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', function(socket) {
  console.log('a user connected');
  // set current state
  socket.emit('available_inputs', availableInputs);
  socket.emit('available_outputs', availableOutputs);
  socket.emit('switched_input', currentInput);
  socket.emit('switched_output', currentOutput);
  socket.emit('changed_output_volume', volume);

  socket.on('disconnect', function(){
    console.log('user disconnected');
  });

  socket.on('change_output_volume', function(msg){
    console.log('change_output_volume: ', msg);
    volume = msg;
    if (airplayDevice !== null) {
      airplayDevice.setVolume(volume, function(){
        console.log('changed airplay volume');
      });
    }
    if (aplayInstance !== null){
      console.log('todo: update correct speaker based on currentOutput device ID');
      console.log(currentOutput);
      var amixer = spawn("amixer", [
        '-c', "1",
        '--', "sset",
        'Speaker', volume+"%"
      ]);
    }
    io.emit('changed_output_volume', msg);
  });

  socket.on('switch_output', function(msg){
    switchOutput(msg);
    io.emit('switched_output', msg);
  });

  socket.on('switch_input', function(msg){
    switchInput(msg);
    io.emit('switched_input', msg);
  });

  socket.on('shutdown', function(msg) {
    console.log('shutting down the system');
    exec("shutdown -h now");
  });

  socket.on('restart', function(msg) {
    console.log('restarting the system');
    exec("reboot");
  });
});

http.listen(3000, function(){
  console.log('listening on *:3000');
});