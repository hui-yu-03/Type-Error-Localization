var p = new Promise(function (res, rej) {
  res(5);
});

var q = p.then(function (x) {
  return x + 1;
});

var r;
q.then(function (y) {
  r = y;
});
