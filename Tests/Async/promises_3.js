var p = new Promise(function (res, rej) {
  res(42);
  rej("something went wrong");
});
