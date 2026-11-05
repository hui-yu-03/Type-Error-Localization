// Variables used as conditions are NOT constrained to bool.
// 'message' is str and 'count' is num — using them as if-conditions
// must not force them to bool.
var message = "hello";
var count = 5;

if (message) {
  count = count + 1;
}

if (count) {
  message = message + " world";
}
