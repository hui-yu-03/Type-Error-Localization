let i = 0;
outer: while (i < 3) {
  let j = 0;
  while (j < 3) {
    if (j === 1) break outer;
    j++;
  }
  i++;
}
