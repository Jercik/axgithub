import { Buffer } from "node:buffer";
import path from "node:path";

const repositoryPath = process.cwd();

/** @param {unknown} event */
function registeredTestFile(event) {
  if (typeof event !== "object" || event === null || !("type" in event) || !("data" in event)) {
    return undefined;
  }
  const data = event.data;
  if (typeof data !== "object" || data === null || !("file" in data) || !("counts" in data)) {
    return undefined;
  }
  const counts = data.counts;
  const registered =
    event.type === "test:summary" &&
    typeof data.file === "string" &&
    typeof counts === "object" &&
    counts !== null &&
    "tests" in counts &&
    typeof counts.tests === "number" &&
    counts.tests > 0;
  return registered ? data.file : undefined;
}

/** @param {AsyncIterable<unknown>} source */
export default async function* reportRegisteredTests(source) {
  const registeredTestFiles = new Set();
  for await (const event of source) {
    const filePath = registeredTestFile(event);
    if (filePath !== undefined) {
      registeredTestFiles.add(path.relative(repositoryPath, filePath));
    }
  }
  for (const filePath of [...registeredTestFiles].toSorted()) {
    yield `${Buffer.from(filePath).toString("base64")}\n`;
  }
}
