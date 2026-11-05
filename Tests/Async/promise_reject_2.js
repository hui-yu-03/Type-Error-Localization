var q = Promise.reject("error").catch(function (e) {
  return 0;
});
