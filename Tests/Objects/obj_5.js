function outer() {
  var base = 100;
  var obj = {};
  obj.x = base;

  function inner() {
    var copied = obj.x;
    var result = copied + 1;
  }

  var check = obj.x + 0;
}
