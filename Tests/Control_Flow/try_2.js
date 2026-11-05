var result = {};
var cleaned = false;

try {
  result.status = 200;
  result.body = "success";
} catch (err) {
  result.status = 500;
  result.body = "failure";
} finally {
  cleaned = true;
  var i_was_here = true;
}
