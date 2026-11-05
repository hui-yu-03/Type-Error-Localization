function f(x) {
  x++;
}

function h(y) {
  f(y);
}

module.exports = h;
