function parse(s) {
  return { value: s };
}

// Chained .then(): type flows through each step.
// Second .then() uses a named function reference instead of an inline callback.
var p = new Promise(function (resolve, reject) {
  resolve("hello");
});

var result = p
  .then(function (s) {
    return s.trim();
  })
  .then(parse);
