var config = {};

function setHost() {
  config.host = "localhost";
  config.secure = false;
}

function setPort() {
  config.port = 8080;
  config.timeout = 30;
}

function setMeta() {
  config.version = 2;
  config.name = "myapp";
}

var h = config.host;
var p = config.port;

//TODO: solver failed
