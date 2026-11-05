var p = new Promise(function (res, rej) {
  res(1);
  rej("oops");
});

var q = p.catch(function (e) {
  return 0;
});
