var a = 1;
var t = typeof a;

var b;
var u = typeof b;

function check(cb) {
  if (typeof cb === "function") {
    cb();
  }
}
