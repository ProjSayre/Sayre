import { formatName } from "./format";

export function testFormatName(): void {
  if (formatName(" Ada ") !== "Ada") throw new Error("unexpected format");
}
