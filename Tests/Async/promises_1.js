// This is the first example from the meeting.

// Xp <= Promise(X_res_arg, X_rej_arg), number <= X_res_arg
var p = new Promise(function (res, rej) {
  res(5);
});

var z;

// X_res_arg <= X_z
p.then(function (x) {
  z = x;
});

// (Xp <= Promise(X_res_arg, X_rej_arg), number <= X_res_arg, X_res_arg <= X_z);
// (Xp <= Promise(number), (X_z = number));
