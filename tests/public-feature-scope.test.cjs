const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

test("public web has no voting, capture or media showcase dead features", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8")
  const copy = fs.readFileSync(path.join(root, "src", "app-copy.js"), "utf8")
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8")
  const combined = `${app}\n${copy}\n${styles}`

  assert.doesNotMatch(combined, /VoteScreen|CaptureScreen|MediaScreen|FACTION_SHOWCASE|MEDIA_GROUPS/)
  assert.doesNotMatch(combined, /interactive(?:Title|Body|Caption|More)|faction-showcase|faction-story/)
  assert.doesNotMatch(combined, /vote-submit|vote-finished|capture-tabs|capture-account|mediaEmpty|noClips|noRecordings/)
  assert.doesNotMatch(combined, /Demo Option|Demo Group|Sample Media/)
})
