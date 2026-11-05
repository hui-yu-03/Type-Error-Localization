var a = Promise.resolve(42);

var p = new Promise(function (res, rej) {
  res(1);
});

var b = Promise.resolve(p);
