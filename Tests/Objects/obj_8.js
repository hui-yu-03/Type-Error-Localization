var state = {};
state.score = 0;
state.lives = 3;
var running = true;

function tick() {
  var score = state.score + 10;
  state.score = score;

  var lives = state.lives;
  var ok = true;

  if (ok) {
    state.lives = lives + 0;
  } else {
    state.lives = lives + 1;
  }
}

var x = 42;

while (running) {
  var x = state.score;
}
