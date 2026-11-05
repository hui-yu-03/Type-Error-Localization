var state = {};
state.running = true;
state.count = 0;

var flag = state.running;

while (flag) {
  var c = state.count;
  state.count = c + 1;
  flag = state.running;
}
