var state = {};
state.count = 0;
var valid = true;

function g(valid) {
  while (valid) {
    state.count = state.count + 1;
  }
}

// Once againg, valid is `bot` because it can really be any type
