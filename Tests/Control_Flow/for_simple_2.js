var count = 100;

function f(j) {
  for (j = 0; j < 50; j = j + 1) {
    // for var j = 0? what would happen
    count = count - 1;
  }
}

var done = true;
