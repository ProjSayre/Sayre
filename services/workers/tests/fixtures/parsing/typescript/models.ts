/* Fixture: an interface (must NOT become a ParsedClass), a base class, a
 * subclass using both `extends` (recorded) and `implements` (excluded per
 * Open Question 5), typed functions/methods, and a `import type` import. */

import type { Describable } from "./types";

interface Describable {
  describe(): string;
}

class Shape implements Describable {
  describe(): string {
    return "shape";
  }
}

class Circle extends Shape {
  radius: number;

  constructor(radius: number) {
    super();
    this.radius = radius;
  }

  area(): number {
    return this.computeArea();
  }

  computeArea(): number {
    return 3.14159 * this.radius * this.radius;
  }
}

function describe(shape: Shape): string {
  return shape.describe();
}

const makeCircle = (radius: number): Circle => {
  return new Circle(radius);
};
