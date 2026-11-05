var state = {};
state.score = 0;
state.bonus = 10;
var active = true;

while (active) {
  var cur = state.score;
  if (active) {
    state.score = cur + state.bonus;
  } else {
    state.score = cur + 1;
  }
}

var total = state.score + 0;
