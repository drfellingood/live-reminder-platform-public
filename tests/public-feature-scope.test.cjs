const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function readWebSource() {
  const allowedExtensions = new Set([".css", ".js", ".jsx"])
  return fs.readdirSync(path.join(root, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && allowedExtensions.has(path.extname(entry.name)))
    .map((entry) => fs.readFileSync(path.join(root, "src", entry.name), "utf8"))
    .join("\n")
}

test("public web has no voting, capture or media showcase dead features", () => {
  const combined = readWebSource()

  assert.doesNotMatch(combined, /VoteScreen|CaptureScreen|MediaScreen|FACTION_SHOWCASE|MEDIA_GROUPS/)
  assert.doesNotMatch(combined, /interactive(?:Title|Body|Caption|More)|faction-showcase|faction-story/)
  assert.doesNotMatch(combined, /vote-submit|vote-finished|capture-tabs|capture-account|mediaEmpty|noClips|noRecordings/)
  assert.doesNotMatch(combined, /Demo Option|Demo Group|Sample Media/)
})
