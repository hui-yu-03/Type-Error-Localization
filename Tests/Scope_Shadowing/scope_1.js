var val = 42;

function transform(val) {
  var local = val;
  var out = local;
}

var copy = val;

var settings = {};

function setNetwork() {
  settings.host = "localhost";
  settings.port = 3000;
}

function setApp() {
  settings.debug = true;
  settings.version = 2;
}
