// shared__global.value has both num and str -> CONFLICT

var shared = {};

function setNum() {
  shared.value = 42;
}

function setStr() {
  shared.value = "hi";
}

var v = shared.value;
