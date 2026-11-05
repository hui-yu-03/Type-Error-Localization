var x = 0;
var msg = "ok";

try {
  x = 10;
  msg = "done";
  var i_was_here = true;
} catch (e) {
  msg = "error";
  var i_was_there = true;
}
