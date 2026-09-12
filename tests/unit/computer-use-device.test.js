'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const png = require('../../app/extensions/mega/theme/png')
const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')
const ports = require('../../app/computer-use/ports.cjs')
const md = require('../helpers/computer-use-minidom.cjs')
const deviceModule = require('../helpers/computer-use-device.cjs')

const { createDevice, FIXTURE_DIR, TITLE_BAR_HEIGHT, DEFAULT_SCREEN } = deviceModule

/**
 * The in-process computer-use device.
 *
 * The point of these tests is that the device is a *state machine*, not a stub:
 * each assertion below follows from real DOM, focus, window or pixel state that
 * an action changed. Determinism is part of the contract too, so the clock is
 * virtual everywhere and no assertion depends on how fast the machine is.
 */

const FIXTURES = [
  'form.html',
  'dynamic.html',
  'miss.html',
  'modal.html',
  'slow.html',
  'canvas.html',
  'stall.html',
  'editor.html'
]

/** Decode a capture and expose a pixel reader in the capture's own coordinates. */
function decodeCapture(shot) {
  const image = png.decodePng(shot.png)
  return {
    width: image.width,
    height: image.height,
    pixel(x, y) {
      const offset = (y * image.width + x) * 4
      return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
    }
  }
}

/** Screen point at the centre of an element hosted by a window. */
function screenPointOf(windowInfo, elementDescriptor) {
  const box = elementDescriptor.bbox
  return {
    x: windowInfo.contentBounds.x + box.x + Math.floor(box.width / 2),
    y: windowInfo.contentBounds.y + box.y + Math.floor(box.height / 2)
  }
}

function refOf(page, selector) {
  return page.query(selector).ref
}

// ------------------------------------------------------------------- ports ---

test('every device port satisfies inspectPort and probes available', () => {
  const device = createDevice()
  try {
    const page = device.openPage('form.html')
    const candidates = {
      page,
      desktop: device.desktop,
      accessibility: device.accessibility,
      screenshot: device.screenshot
    }
    for (const [name, candidate] of Object.entries(candidates)) {
      const verdict = ports.inspectPort(name, candidate)
      assert.deepEqual(verdict.missing, [], `${name} port is missing methods`)
      assert.equal(verdict.ok, true, `${name} port must satisfy inspectPort`)
      const probe = ports.normalizeProbe(candidate.probe())
      assert.equal(probe.available, true, `${name} probe must report availability`)
      assert.equal(probe.detail.backend, 'device', `${name} probe must name the device backend`)
    }
    assert.deepEqual(ports.PAGE_ADAPTER_METHODS.filter((method) => typeof page[method] !== 'function'), [])
    assert.deepEqual(ports.DESKTOP_DRIVER_METHODS.filter((method) => typeof device.desktop[method] !== 'function'), [])
    assert.deepEqual(ports.ACCESSIBILITY_DRIVER_METHODS.filter((method) => typeof device.accessibility[method] !== 'function'), [])
    assert.deepEqual(ports.SCREENSHOT_DRIVER_METHODS.filter((method) => typeof device.screenshot[method] !== 'function'), [])
  } finally {
    device.dispose()
  }
})

test('all fixture pages are present and readable', () => {
  for (const name of FIXTURES) {
    const fixture = deviceModule.loadFixture(name)
    assert.equal(fixture.name, name)
    assert.ok(fixture.html.includes('<html'), `${name} must be a full document`)
    assert.ok(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8').length > 0)
  }
})

// ---------------------------------------------------------------- mini-DOM ---

test('mini-DOM parses tags, attributes, text, self-closing tags and entities', () => {
  const doc = md.createDocument({
    html: `<!doctype html>
<html><head><title>Parse &amp; check</title></head>
<body>
  <!-- a comment that must be skipped -->
  <div id="box" class="outer wide" data-role="panel" hidden>
    <span class="label">a &lt; b &amp;&amp; c &gt; d</span>
    <input id="tiny" type="text" required>
    <br>
    <img id="pic" src="x.png" alt="pic">
  </div>
  <p>tail &#39;quoted&#39; &quot;text&quot;</p>
</body></html>`
  })
  assert.equal(doc.title, 'Parse & check')
  assert.equal(doc.documentElement.tagName, 'html')
  assert.equal(doc.body.tagName, 'body')
  const box = doc.getElementById('box')
  assert.equal(box.tagName, 'div')
  assert.equal(box.getAttribute('class'), 'outer wide')
  assert.equal(box.className, 'outer wide')
  assert.equal(box.classList.contains('wide'), true)
  assert.equal(box.hasAttribute('hidden'), true)
  assert.equal(box.visible, false)
  assert.equal(box.children.length, 4)
  assert.equal(box.children[0].tagName, 'span')
  assert.equal(md.normalizeText(box.children[0].textContent), 'a < b && c > d')
  assert.equal(doc.getElementById('tiny').hasAttribute('required'), true)
  assert.equal(doc.getElementById('tiny').children.length, 0)
  assert.equal(doc.getElementById('pic').getAttribute('alt'), 'pic')
  assert.equal(doc.body.children[1].innerText, "tail 'quoted' \"text\"")
  // Comments leave no node behind.
  assert.equal(doc.body.childNodes.filter((node) => node.nodeType === 8).length, 0)
})

test('mini-DOM query selectors cover the documented subset in document order', () => {
  const doc = md.createDocument({
    html: `<body>
  <form id="f">
    <div class="field"><label for="a">A</label><input id="a" type="text"></div>
    <div class="field"><label for="b">B</label><input id="b" type="password"></div>
    <button id="go" type="submit" data-kind="primary">Go</button>
  </form>
  <input id="loose" type="text">
</body>`
  })
  assert.deepEqual(doc.querySelectorAll('#f').map((el) => el.id), ['f'])
  assert.deepEqual(doc.querySelectorAll('.field').map((el) => el.tagName), ['div', 'div'])
  assert.deepEqual(doc.querySelectorAll('input').map((el) => el.id), ['a', 'b', 'loose'])
  assert.deepEqual(doc.querySelectorAll('[data-kind]').map((el) => el.id), ['go'])
  assert.deepEqual(doc.querySelectorAll('[type="password"]').map((el) => el.id), ['b'])
  assert.deepEqual(doc.querySelectorAll('form input').map((el) => el.id), ['a', 'b'])
  assert.deepEqual(doc.querySelectorAll('#f > div').map((el) => el.className), ['field', 'field'])
  assert.deepEqual(doc.querySelectorAll('#a, #go, #loose').map((el) => el.id), ['a', 'go', 'loose'])
  assert.equal(doc.querySelector('form > input'), null)
  assert.equal(doc.querySelector('#f').querySelector('input').id, 'a')
  assert.equal(doc.querySelectorAll('div:nth-child(2)')[0].getAttribute('class'), 'field')
  // Deterministic: two identical queries return the same order.
  const first = doc.querySelectorAll('input').map((el) => el.ref)
  const second = doc.querySelectorAll('input').map((el) => el.ref)
  assert.deepEqual(first, second)
  assert.throws(() => doc.querySelectorAll(':hover'), /unsupported (pseudo class|selector)/)
})

test('mini-DOM layout follows the documented metrics', () => {
  const doc = md.createDocument({
    html: `<body>
  <div id="first" style="width:300px">abc</div>
  <div id="second">def</div>
  <button id="press" type="button">Press me</button>
  <span id="inline">xy</span><span id="inline2">z</span>
  <div id="ghost" style="display:none">hidden text</div>
  <div id="faded" style="opacity:0">faded but present</div>
  <div id="gone" style="opacity:0;visibility:hidden">gone</div>
  <div id="floating" style="position:absolute;left:640px;top:420px;width:100px;height:30px"></div>
</body>`
  })
  doc.ensureLayout()
  // CHAR_WIDTH 8, LINE_HEIGHT 20, no user-agent margins.
  assert.deepEqual(doc.getElementById('first').bbox, { x: 0, y: 0, width: 300, height: 20 })
  // A block child stacks under the previous block, full viewport width.
  assert.deepEqual(doc.getElementById('second').bbox, { x: 0, y: 20, width: 1024, height: 20 })
  // 'Press me' is 8 characters -> 64 px plus 8 px padding on both sides.
  assert.deepEqual(doc.getElementById('press').bbox, { x: 0, y: 40, width: 80, height: 20 })
  // Inline elements continue the open line box, left to right.
  assert.deepEqual(doc.getElementById('inline').bbox, { x: 80, y: 40, width: 16, height: 20 })
  assert.deepEqual(doc.getElementById('inline2').bbox, { x: 96, y: 40, width: 8, height: 20 })
  // display:none takes no space and is not visible.
  assert.equal(doc.getElementById('ghost').visible, false)
  const ghostBox = doc.getElementById('ghost').bbox
  assert.equal(ghostBox.width, 0)
  assert.equal(ghostBox.height, 0)
  // opacity:0 alone stays visible (a browser keeps it hit-testable);
  // opacity:0 with visibility:hidden does not.
  assert.equal(doc.getElementById('faded').visible, true)
  assert.equal(doc.getElementById('gone').visible, false)
  // Absolutely positioned elements land exactly where the style says.
  assert.deepEqual(doc.getElementById('floating').bbox, { x: 640, y: 420, width: 100, height: 30 })
  assert.equal(doc.hitTest(650, 430).id, 'floating')
  assert.equal(doc.hitTest(10, 10).id, 'first')
})

test('mini-DOM relayout and scroll really move boxes', () => {
  const doc = md.createDocument({
    html: '<body><div id="mover" style="position:absolute;left:10px;top:10px;width:40px;height:20px"></div></body>'
  })
  const mover = doc.getElementById('mover')
  assert.deepEqual(mover.bbox, { x: 10, y: 10, width: 40, height: 20 })
  mover.setAttribute('style', 'position:absolute;left:300px;top:150px;width:40px;height:20px')
  doc.relayout()
  assert.deepEqual(mover.bbox, { x: 300, y: 150, width: 40, height: 20 })
  assert.equal(doc.hitTest(310, 160).id, 'mover')
  assert.equal(doc.hitTest(20, 20), null)
  // Scrolling moves the viewport offset, so viewport boxes shift by exactly that.
  const tall = md.createDocument({
    html: '<body><div style="height:2000px"></div><button id="deep" style="position:absolute;left:10px;top:1500px">Deep</button></body>'
  })
  assert.equal(tall.getElementById('deep').bbox.y, 1500)
  tall.setScroll(0, 600)
  assert.equal(tall.scrollY, 600)
  assert.equal(tall.getElementById('deep').bbox.y, 900)
  assert.equal(tall.getElementById('deep').layoutRect.y, 1500)
})

test('mini-DOM dispatchEvent bubbles and honours preventDefault', () => {
  const doc = md.createDocument({
    html: '<body><form id="f"><button id="b" type="submit">Send</button></form></body>'
  })
  const form = doc.getElementById('f')
  const button = doc.getElementById('b')
  const order = []
  button.addEventListener('click', () => order.push('button'))
  form.addEventListener('click', () => order.push('form'))
  doc.addEventListener('click', () => order.push('document'))
  const submits = []
  doc.setHooks({
    onEventScript(event) {
      if (event.type === 'submit') order.push('script:submit')
    },
    onSubmit(hookForm) {
      submits.push(hookForm.id)
      order.push('submit-hook')
    }
  })
  button.click()
  assert.deepEqual(order, ['button', 'form', 'document', 'script:submit', 'submit-hook'])
  assert.deepEqual(submits, ['f'])

  // A listener that prevents the submit stops the form handler completely.
  order.length = 0
  const preventSubmit = (event) => event.preventDefault()
  form.addEventListener('submit', preventSubmit)
  button.click()
  assert.deepEqual(order, ['button', 'form', 'document'])
  assert.deepEqual(submits, ['f'])
  form.removeEventListener('submit', preventSubmit)

  // Preventing the click cancels its default action (the submit) but still bubbles.
  order.length = 0
  const preventClick = (event) => event.preventDefault()
  button.addEventListener('click', preventClick)
  assert.equal(button.click(), false)
  assert.deepEqual(order, ['button', 'form', 'document'])
  assert.deepEqual(submits, ['f'])
  button.removeEventListener('click', preventClick)
})

test('mini-DOM tracks mutations with a revision and notifies listeners', () => {
  const doc = md.createDocument({ html: '<body><p id="note">one</p></body>' })
  const seen = []
  doc.onMutation((record) => seen.push(record.type))
  const note = doc.getElementById('note')
  assert.equal(doc.revision, 0)
  note.setAttribute('class', 'x')
  assert.equal(doc.revision, 1)
  note.textContent = 'two'
  assert.equal(doc.revision, 2)
  note.classList.add('y')
  assert.equal(doc.revision, 3)
  const input = doc.createElement('input')
  doc.body.appendChild(input)
  assert.equal(doc.revision, 4)
  input.value = 'typed'
  assert.equal(doc.revision, 5)
  assert.deepEqual(seen, ['attribute', 'text', 'attribute', 'childList', 'value'])
  assert.equal(doc.mutationsSince(3).length, 2)
  assert.deepEqual(doc.mutationsSince(3).map((record) => record.type), ['childList', 'value'])
  assert.equal(doc.mutationsSince(3)[0].selector, 'body')
  assert.equal(doc.mutationsSince(4)[0].selector, 'body > input')
  assert.equal(doc.mutationsSince(4)[0].target, input.ref)
})

// ------------------------------------------------------------- page adapter ---

test('page adapter types into fields with real events and reads the value back', () => {
  const device = createDevice()
  try {
    const page = device.openPage('form.html')
    const inputEvents = []
    page.document.getElementById('username').addEventListener('input', (event) => inputEvents.push(event.detail.value))
    const before = page.snapshot().revision
    const receipt = page.typeText('#username', 'ada')
    assert.equal(receipt.ok, true)
    assert.equal(page.query('#username').value, 'ada')
    assert.equal(page.document.getElementById('username').value, 'ada')
    assert.deepEqual(inputEvents, ['a', 'ad', 'ada'])
    assert.ok(page.snapshot().revision > before, 'typing must bump the revision')
    assert.equal(page.snapshot().focusedRef, refOf(page, '#username'))

    // setValue fires input + change, and clear replaces instead of appending.
    const named = []
    page.document.getElementById('username').addEventListener('change', () => named.push('change'))
    page.setValue('#username', 'grace')
    assert.deepEqual(named, ['change'])
    page.typeText('#username', 'hopper', { clear: true })
    assert.equal(page.query('#username').value, 'hopper')

    // Typing on the checkbox is not a thing; the device says so with a typed error.
    assert.throws(() => page.typeText('#remember', 'x'), (error) => error instanceof ComputerUseError && error.code === CODES.ACTION_UNSUPPORTED)

    // A real click toggles the checkbox through the label.
    assert.equal(page.query('#remember').checked, false)
    page.clickElement('#remember')
    assert.equal(page.query('#remember').checked, true)
  } finally {
    device.dispose()
  }
})

test('page adapter submits the form and the page state really changes', () => {
  const device = createDevice()
  try {
    const page = device.openPage('form.html')
    page.typeText('#username', 'ada')
    page.typeText('#password', 's3cret')
    const receipt = page.clickElement('#sign-in')
    assert.equal(receipt.detail.swallowed, false)
    assert.ok(receipt.detail.revisionAfter > receipt.detail.revisionBefore, 'a submit must change the page')
    assert.equal(page.query('#status').visible, true)
    assert.equal(page.query('#status').text, 'Saved')
    assert.equal(page.query('#status').role, 'status')
    assert.equal(page.query('#error').visible, false)
    // The fixture clears the password on success: real state, not a canned answer.
    assert.equal(page.query('#password').value, '')

    // An empty username produces the error node naming that field.
    const invalid = device.openPage('form.html')
    invalid.clickElement('#sign-in')
    assert.equal(invalid.query('#error').visible, true)
    assert.equal(invalid.query('#error').text, 'Username is required')
    assert.equal(invalid.query('#status').visible, false)
    const username = invalid.query('#username')
    assert.equal(username.attributes['aria-invalid'], 'true')
    assert.equal(invalid.query('#password').attributes['aria-invalid'], 'true')
  } finally {
    device.dispose()
  }
})

test('waitFor is event driven on the virtual clock, not a fixed sleep', async () => {
  const device = createDevice()
  try {
    const page = device.openPage('slow.html')
    // 700 ms button: the effect must not exist until virtual time reaches it.
    page.clickElement('#slow')
    assert.equal(page.query('#slow-result').visible, false)
    assert.equal(page.query('#slow').disabled, true, 'a pending action marks the control busy')
    const startWall = Date.now()
    const slowWait = await page.waitFor({ condition: 'selector', selector: '#slow-result.done', timeoutMs: 5000 })
    assert.equal(slowWait.waitedMs, 700)
    assert.equal(device.clock.now(), 700)
    assert.equal(page.query('#slow-result').visible, true)
    assert.equal(page.query('#slow-result').text, 'Slow finished')
    assert.equal(page.query('#slow').disabled, false)
    // 700 ms of fixture delay must not cost 700 ms of wall clock.
    assert.ok(Date.now() - startWall < 2000, 'waitFor must not sleep on the wall clock')

    // The fast button proves the device applies each declared delay, not one constant.
    page.clickElement('#fast')
    const fastWait = await page.waitFor({ condition: 'selector', selector: '#fast-result.done', timeoutMs: 5000 })
    assert.equal(fastWait.waitedMs, 120)
    assert.equal(device.clock.now(), 820)
    assert.equal(page.query('#fast-result').text, 'Fast finished')
  } finally {
    device.dispose()
  }
})

test('waitFor reports a typed timeout and still advances virtual time only to the deadline', async () => {
  const device = createDevice()
  try {
    const page = device.openPage('stall.html')
    await assert.rejects(
      () => page.waitFor({ condition: 'selector', selector: '#never-appears', timeoutMs: 300 }),
      (error) => {
        assert.equal(error.code, CODES.ACTION_TIMEOUT)
        assert.equal(error.retryable, true)
        assert.equal(error.details.selector, '#never-appears')
        return true
      }
    )
    assert.equal(device.clock.now(), 300)
    await assert.rejects(
      () => page.waitFor({ condition: 'nonsense', timeoutMs: 10 }),
      (error) => error.code === CODES.ACTION_INVALID
    )
  } finally {
    device.dispose()
  }
})

test('data-cu-eat-clicks makes the first click a genuine no-op', () => {
  const device = createDevice()
  try {
    const page = device.openPage('miss.html')
    const revision = page.snapshot().revision
    const first = page.clickElement('#arm')
    assert.equal(first.ok, true, 'the click is delivered')
    assert.equal(first.detail.swallowed, true, 'but the page swallows it')
    assert.equal(page.query('#state').visible, false)
    assert.equal(page.snapshot().revision, revision, 'a swallowed click changes nothing')
    const second = page.clickElement('#arm')
    assert.equal(second.detail.swallowed, false)
    assert.equal(page.query('#state').visible, true)
    assert.equal(page.query('#state').text, 'Armed')
  } finally {
    device.dispose()
  }
})

test('a modal blocks the page until it is dismissed and a JS dialog freezes it', () => {
  const device = createDevice()
  try {
    const page = device.openPage('modal.html')
    page.clickElement('#open-modal')
    let snapshot = page.snapshot()
    assert.equal(snapshot.modals.length, 1)
    assert.equal(page.query('[role="dialog"]').name, 'Delete this file?')
    assert.equal(page.query('#behind').actionable, false, 'a modal blocks the controls behind it')
    assert.throws(
      () => page.clickElement('#behind'),
      (error) => error.code === CODES.MODAL_BLOCKING && error.retryable === true
    )
    // The blocking overlay is a real node, so a coordinate click lands on it.
    const overlayHit = page.document.hitTest(10, 10)
    assert.equal(overlayHit.getAttribute('data-cu-overlay'), '1')
    // The dismiss button inside the dialog is the way out.
    const dismiss = snapshot.controls.find((control) => control.name === 'Dismiss')
    assert.equal(dismiss.actionable, true)
    page.clickElement(dismiss.ref)
    snapshot = page.snapshot()
    assert.equal(snapshot.modals.length, 0)
    assert.equal(page.query('#behind').actionable, true)
    page.clickElement('#behind')
    assert.equal(page.query('#behind-state').text, 'Behind clicked')

    // A blocking confirm dialog: loading stays true and nothing is actionable.
    page.events().sinceLastCheck()
    page.clickElement('#publish')
    const dialogEvents = page.events().sinceLastCheck().map((event) => event.type)
    assert.ok(dialogEvents.includes('dialog_opened'), `expected dialog_opened in ${dialogEvents.join(',')}`)
    assert.ok(dialogEvents.includes('load_state_changed'))
    assert.deepEqual(page.dialogs().map((dialog) => dialog.type), ['confirm'])
    assert.equal(page.snapshot().loading, true)
    assert.equal(page.query('#publish').actionable, false)
    assert.equal(page.snapshot().controls.every((control) => control.actionable === false), true)
    assert.throws(() => page.clickElement('#behind'), (error) => error.code === CODES.MODAL_BLOCKING)
    const answered = page.answerDialog({ accept: true })
    assert.equal(answered.detail.ranAcceptScript, true)
    assert.equal(page.snapshot().loading, false)
    assert.equal(page.query('#published').text, 'Published')
    assert.equal(page.query('#publish').actionable, true)
  } finally {
    device.dispose()
  }
})

test('a fixture can move a control after load and the device follows the move', async () => {
  const device = createDevice()
  try {
    const page = device.openPage('dynamic.html')
    const before = page.query('#moving').bbox
    assert.equal(before.x, 0)
    assert.ok(before.y < 100, 'the button starts in the normal flow')
    const oldPoint = { x: before.x + 2, y: before.y + 2 }
    assert.equal(page.document.hitTest(oldPoint.x, oldPoint.y).id, 'moving')

    const wait = await page.waitFor({ condition: 'mutation', selector: '#moving', timeoutMs: 3000 })
    assert.equal(wait.waitedMs, 250, 'the move is declared as 250 ms after load')
    const after = page.query('#moving').bbox
    assert.equal(after.x, 640)
    assert.equal(after.y, 420)
    // The old coordinates really are empty now: the element moved in layout, not in a table.
    assert.equal(page.document.hitTest(oldPoint.x, oldPoint.y), null)
    assert.equal(page.document.hitTest(645, 425).id, 'moving')
    page.clickElement('#moving')
    assert.equal(page.query('#clicked').text, 'Clicked')
    // The static reference never moved.
    assert.deepEqual(page.query('#reference').bbox, { x: 40, y: 200, width: 160, height: 24 })
  } finally {
    device.dispose()
  }
})

test('a frozen page applies nothing but is still alive', async () => {
  const device = createDevice()
  try {
    const page = device.openPage('stall.html')
    page.clickElement('#apply')
    assert.equal(page.debug().frozen, true)
    const revision = page.snapshot().revision
    assert.equal(page.query('#applied').visible, false)
    // Clicking again, and waiting, change nothing at all.
    page.clickElement('#apply')
    await assert.rejects(
      () => page.waitFor({ condition: 'selector', selector: '#applied', visible: true, timeoutMs: 100 }),
      (error) => error.code === CODES.ACTION_TIMEOUT
    )
    assert.equal(page.snapshot().revision, revision)

    // The liveness probe still works: typing is user input, not an application change.
    page.typeText('#alive', 'ping')
    assert.equal(page.query('#alive').value, 'ping')
    assert.ok(page.snapshot().revision > revision)
    assert.equal(page.snapshot().loading, false)
  } finally {
    device.dispose()
  }
})

test('navigation, history and reload are real state transitions', () => {
  const device = createDevice()
  try {
    const page = device.openPage('form.html')
    const formRevision = page.snapshot().revision
    const formRef = refOf(page, '#username')
    page.focusElement('#username')
    assert.equal(page.snapshot().focusedRef, formRef)

    const navigated = page.navigate('miss.html')
    assert.equal(navigated.ok, true)
    assert.equal(page.url, 'https://device.test/miss.html')
    assert.equal(page.snapshot().title, 'Swallowed click')
    assert.ok(page.snapshot().revision > formRevision, 'the revision keeps increasing across loads')
    assert.equal(page.snapshot().focusedRef, null, 'a navigation clears focus')
    assert.equal(page.query('#arm').visible, true)
    assert.throws(() => page.query(formRef), (error) => error.code === CODES.TARGET_STALE)

    const back = page.historyBack()
    assert.equal(back.ok, true)
    assert.equal(page.url, 'https://device.test/form.html')
    assert.equal(page.snapshot().title, 'Sign in')
    assert.equal(page.query('#sign-in').visible, true)

    const forward = page.historyForward()
    assert.equal(forward.ok, true)
    assert.equal(page.url, 'https://device.test/miss.html')

    const reloadRevision = page.snapshot().revision
    const reloaded = page.reload()
    assert.equal(reloaded.ok, true)
    assert.equal(page.url, 'https://device.test/miss.html')
    assert.ok(page.snapshot().revision > reloadRevision)

    page.navigate('form.html')
    page.navigate('form.html')
    assert.equal(page.historyBack().ok, true)
    assert.equal(page.historyForward().ok, true)
    assert.equal(page.historyForward().ok, false, 'the forward stack is empty again')
    assert.equal(page.historyForward().detail.reason, 'NO_HISTORY')
  } finally {
    device.dispose()
  }
})

test('tabs are real pages in one browser and closing one really removes it', () => {
  const device = createDevice()
  try {
    const first = device.openPage('form.html')
    const second = device.openPage('miss.html')
    const tabs = first.tabs()
    assert.equal(tabs.length, 2)
    assert.deepEqual(tabs.map((tab) => tab.id), [first.id, second.id])
    assert.equal(tabs.find((tab) => tab.id === second.id).active, true)
    assert.equal(tabs.find((tab) => tab.id === first.id).active, false)
    assert.equal(device.pages.length, 2)
    assert.equal(second.tabs().length, 2)
    second.close()
    assert.equal(device.pages.length, 1)
    assert.deepEqual(first.tabs().map((tab) => tab.id), [first.id])
    assert.equal(first.tabs()[0].active, true)
  } finally {
    device.dispose()
  }
})

test('scrolling moves the real viewport offset', () => {
  const device = createDevice()
  try {
    const page = device.openPage({
      html: '<!doctype html><html><head><title>Tall</title></head><body><div style="height:2000px"></div><button id="deep" type="button" style="position:absolute;left:10px;top:1500px">Deep</button></body></html>'
    })
    assert.equal(page.query('#deep').bbox.y, 1500)
    const scrolled = page.scroll({ deltaY: 600 })
    assert.equal(scrolled.detail.scroll.y, 600)
    assert.equal(page.query('#deep').bbox.y, 900)
    assert.equal(page.snapshot().scroll.y, 600)
    // Scrolling an element into view really moves the offset.
    page.scroll({ ref: '#deep' })
    assert.equal(page.snapshot().scroll.y, 1500 - (768 - 20))
    assert.equal(page.scroll({ y: 0 }).detail.scroll.y, 0)
  } finally {
    device.dispose()
  }
})

test('the page event log records real transitions with sinceLastCheck semantics', () => {
  const device = createDevice()
  try {
    const page = device.openPage('modal.html')
    page.events().sinceLastCheck()
    page.clickElement('#behind')
    const clicked = page.events().sinceLastCheck()
    const clickedTypes = clicked.map((event) => event.type)
    assert.ok(clickedTypes.includes('focus_changed'), `expected focus_changed in ${clickedTypes.join(',')}`)
    assert.ok(clickedTypes.includes('dom_mutated'), `expected dom_mutated in ${clickedTypes.join(',')}`)
    assert.equal(page.query('#behind-state').text, 'Behind clicked')
    assert.deepEqual(page.events().sinceLastCheck(), [], 'a second check sees nothing new')

    page.clickElement('#open-modal')
    const opened = page.events().sinceLastCheck().map((event) => event.type)
    assert.ok(opened.includes('modal_opened'))
    assert.ok(opened.includes('dom_mutated'))

    page.navigate('form.html')
    const afterNavigation = page.events().sinceLastCheck().map((event) => event.type)
    assert.ok(afterNavigation.includes('url_changed'))
    assert.ok(afterNavigation.includes('load_state_changed'))
    assert.ok(device.events.all().some((event) => event.type === 'page_opened'))
    assert.ok(device.events.all().some((event) => event.type === 'mouse_clicked') === false)
  } finally {
    device.dispose()
  }
})

test('waitFor covers selector, mutation, navigation, load and idle', async () => {
  const device = createDevice()
  try {
    const html = '<!doctype html><html data-cu-load-ms="150"><head><title>Slow load</title></head><body>'
      + '<button id="mark" type="button" data-cu-delay-ms="40" data-cu-on-click="class-add #mark done">Mark</button>'
      + '<button id="go" type="button" data-cu-delay-ms="80" data-cu-on-click="navigate form.html">Go</button>'
      + '</body></html>'
    const page = device.openPage({ html, url: 'https://device.test/slowload.html' })
    assert.equal(page.snapshot().readyState, 'loading')
    assert.equal(page.snapshot().loading, true)
    assert.equal(page.snapshot().controls[0].actionable, false, 'a loading page is not actionable')
    assert.throws(() => page.clickElement('#mark'), (error) => error.code === CODES.TARGET_NOT_ACTIONABLE && error.details.reason === 'loading')

    const loaded = await page.waitFor({ condition: 'load', timeoutMs: 1000 })
    assert.equal(loaded.waitedMs, 150, 'the load finishes on the declared data-cu-load-ms')
    assert.equal(page.snapshot().readyState, 'complete')
    assert.equal(page.snapshot().loading, false)
    assert.equal(page.query('#mark').actionable, true)

    page.clickElement('#mark')
    assert.equal(page.query('#mark').disabled, true, 'the deferred action marks the control busy at once')
    const mutated = await page.waitFor({ condition: 'mutation', selector: '#mark', timeoutMs: 1000 })
    assert.equal(mutated.waitedMs, 40, 'waiting for a mutation lands on the deferred effect')
    assert.equal(page.query('#mark').disabled, false)
    assert.equal(page.query('#mark').attributes.class, 'done')

    page.clickElement('#go')
    const navigated = await page.waitFor({ condition: 'navigation', timeoutMs: 1000 })
    assert.equal(navigated.waitedMs, 80, 'the navigation is declared 80 ms after the click')
    assert.equal(page.url, 'https://device.test/form.html')
    const selected = await page.waitFor({ condition: 'selector', selector: '#sign-in', timeoutMs: 1000 })
    assert.equal(selected.waitedMs, 0)
    const idle = await page.waitFor({ condition: 'idle', timeoutMs: 1000 })
    assert.equal(idle.matched, true)
    assert.equal(idle.waitedMs, 0)
  } finally {
    device.dispose()
  }
})

test('selectOption changes the real select state and fires input and change', () => {
  const device = createDevice()
  try {
    const page = device.openPage({
      html: `<!doctype html><html><head><title>Pick</title></head><body><form id="f">
        <label for="pick">Pick</label>
        <select id="pick" name="pick"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
      </form></body></html>`
    })
    const events = []
    const select = page.document.getElementById('pick')
    select.addEventListener('input', (event) => events.push(`input:${event.detail.value}`))
    select.addEventListener('change', (event) => events.push(`change:${event.detail.value}`))
    assert.equal(page.query('#pick').value, 'a', 'the first option is selected by default')
    assert.equal(page.query('#pick').role, 'combobox')
    assert.equal(page.selectOption('#pick', 'b').detail.value, 'b')
    assert.deepEqual(events, ['input:b', 'change:b'])
    assert.equal(page.query('#pick').value, 'b')
    assert.equal(page.document.querySelector('option[value="b"]').hasAttribute('selected'), true)
    assert.equal(page.document.querySelector('option[value="a"]').hasAttribute('selected'), false)
    assert.equal(page.selectOption('#pick', { label: 'Gamma' }).detail.value, 'c')
    assert.equal(page.selectOption('#pick', { index: 0 }).detail.label, 'Alpha')
    assert.throws(() => page.selectOption('#pick', 'zzz'), (error) => error.code === CODES.TARGET_NOT_FOUND)
    assert.throws(() => page.selectOption('#f', 'b'), (error) => error.code === CODES.ACTION_UNSUPPORTED)
  } finally {
    device.dispose()
  }
})

// ----------------------------------------------------------------- desktop ---

test('windows keep a real z-order and focus follows the foreground', () => {
  const device = createDevice()
  try {
    const first = device.desktop.openApplication({ title: 'First', fixture: 'form.html' })
    const second = device.desktop.openApplication({ title: 'Second', fixture: 'miss.html', bounds: { x: 500, y: 300, width: 400, height: 300 } })
    let windows = device.desktop.listWindows()
    assert.deepEqual(windows.map((window) => window.handle), [second.detail.handle, first.detail.handle])
    assert.equal(windows[0].foreground, true)
    assert.equal(windows[1].foreground, false)
    assert.equal(device.desktop.foregroundWindow(), second.detail.handle)
    assert.equal(second.detail.className, 'VirtualWindow')
    assert.equal(typeof second.detail.processId, 'number')
    assert.equal(windows[0].processId !== windows[1].processId, true)

    device.desktop.focusWindow(first.detail.handle)
    windows = device.desktop.listWindows()
    assert.deepEqual(windows.map((window) => window.handle), [first.detail.handle, second.detail.handle])
    assert.equal(device.desktop.foregroundWindow(), first.detail.handle)

    const moved = device.desktop.moveWindow(second.detail.handle, { x: 700, y: 500 })
    assert.deepEqual(moved.detail.bounds, { x: 700, y: 500, width: 400, height: 300 })
    assert.deepEqual(moved.detail.contentBounds, { x: 700, y: 500 + TITLE_BAR_HEIGHT, width: 400, height: 300 - TITLE_BAR_HEIGHT })
    // The page viewport follows the window it lives in.
    assert.deepEqual(device.page(second.detail.pageId).snapshot().viewport, { x: 0, y: 0, width: 400, height: 300 - TITLE_BAR_HEIGHT })

    device.desktop.closeWindow(second.detail.handle)
    assert.equal(device.desktop.listWindows().length, 1)
    assert.equal(device.pages.some((page) => page.id === second.detail.pageId), false, 'closing a window closes its page')
  } finally {
    device.dispose()
  }
})

test('a click at screen coordinates reaches the page underneath', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Browser', fixture: 'form.html' })
    const page = device.page(app.detail.pageId)
    page.typeText('#username', 'ada')
    page.typeText('#password', 's3cret')
    const point = screenPointOf(app.detail, page.query('#sign-in'))
    assert.deepEqual(device.desktop.cursorPosition(), { x: 0, y: 0 })
    const receipt = device.desktop.click(point)
    assert.equal(receipt.detail.hit, 'element')
    assert.equal(receipt.detail.ref, refOf(page, '#sign-in'))
    assert.equal(receipt.detail.window, app.detail.handle)
    assert.deepEqual(device.desktop.cursorPosition(), point)
    assert.equal(page.query('#status').text, 'Saved')
    // A click that misses every window is an honest miss, not an exception.
    const missed = device.desktop.click({ x: 1279, y: 799 })
    assert.equal(missed.ok, false)
    assert.equal(missed.detail.reason, 'NO_WINDOW')
  } finally {
    device.dispose()
  }
})

test('a click on a covered region hits the covering window, not the page behind it', () => {
  const device = createDevice()
  try {
    const lower = device.desktop.openApplication({ title: 'Form', fixture: 'form.html' })
    const lowerPage = device.page(lower.detail.pageId)
    lowerPage.typeText('#username', 'ada')
    lowerPage.typeText('#password', 's3cret')
    const submitPoint = screenPointOf(lower.detail, lowerPage.query('#sign-in'))
    const lowerRevision = lowerPage.snapshot().revision

    // The covering window sits exactly over that point.
    const upper = device.desktop.openApplication({
      title: 'Cover',
      fixture: 'miss.html',
      bounds: { x: submitPoint.x - 20, y: submitPoint.y - 40, width: 300, height: 200 }
    })
    const upperPage = device.page(upper.detail.pageId)

    const blocked = device.desktop.click(submitPoint)
    assert.equal(blocked.detail.window, upper.detail.handle, 'the topmost window takes the click')
    assert.equal(device.desktop.foregroundWindow(), upper.detail.handle)
    assert.equal(lowerPage.snapshot().revision, lowerRevision, 'the covered page must not change')
    assert.equal(lowerPage.query('#status').visible, false)
    assert.equal(upperPage.query('#arm').visible, true)
    assert.equal(blocked.detail.tag, 'h1', 'the click landed in the covering page, not on the covered control')

    // Move the cover away: the same coordinates now reach the lower page.
    device.desktop.moveWindow(upper.detail.handle, { x: 700, y: 500 })
    const reached = device.desktop.click(submitPoint)
    assert.equal(reached.detail.window, lower.detail.handle)
    assert.equal(reached.detail.ref, refOf(lowerPage, '#sign-in'))
    assert.equal(lowerPage.query('#status').text, 'Saved')
  } finally {
    device.dispose()
  }
})

test('the clipboard round-trips through Ctrl+C and Ctrl+V', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Editor', fixture: 'editor.html' })
    const page = device.page(app.detail.pageId)
    const content = app.detail.contentBounds

    device.desktop.click(screenPointOf(app.detail, page.query('#doc')))
    assert.equal(page.snapshot().focusedRef, refOf(page, '#doc'))
    assert.equal(device.desktop.typeText('hello device').detail.inserted, 12)
    assert.equal(page.query('#doc').value, 'hello device')

    device.desktop.keyPress('Ctrl+A')
    assert.equal(device.desktop.keyPress('Ctrl+C').detail.copied, 12)
    assert.equal(device.desktop.clipboardRead(), 'hello device')

    // Paste into the other field of the same document.
    device.desktop.click(screenPointOf(app.detail, page.query('#plain')))
    assert.equal(device.desktop.keyPress('Ctrl+V').detail.value, 'hello device')
    assert.equal(page.query('#plain').value, 'hello device')

    // The port writes and reads the same buffer.
    device.desktop.clipboardWrite('from the port')
    assert.equal(device.desktop.clipboardRead(), 'from the port')
    assert.equal(device.clipboard.text, 'from the port')
    device.desktop.click({ x: content.x + 4, y: content.y + 4 })
    device.desktop.click(screenPointOf(app.detail, page.query('#doc')))
    device.desktop.keyPress('Ctrl+A')
    device.desktop.keyPress('Ctrl+V')
    assert.equal(page.query('#doc').value, 'from the port')
    // Ctrl+C with nothing selected is an honest failure.
    assert.equal(device.desktop.keyPress('Ctrl+X').ok, false)
  } finally {
    device.dispose()
  }
})

test('key handling covers Enter, Tab, Escape, Backspace and Ctrl+S', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Editor', fixture: 'editor.html' })
    const page = device.page(app.detail.pageId)
    device.desktop.click(screenPointOf(app.detail, page.query('#doc')))

    device.desktop.typeText('draft')
    assert.equal(page.query('#doc').value, 'draft')
    assert.equal(device.desktop.keyPress('Backspace').detail.value, 'draf')
    assert.equal(device.desktop.keyPress('Backspace').detail.value, 'dra')
    device.desktop.typeText('ft')
    assert.equal(page.query('#doc').value, 'draft')

    const tabbed = device.desktop.keyPress('Tab')
    assert.equal(tabbed.detail.selector, '#plain')
    assert.equal(page.snapshot().focusedRef, refOf(page, '#plain'))
    device.desktop.keyPress({ key: 'Tab', modifiers: [] })
    assert.equal(page.snapshot().focusedRef, refOf(page, '#doc'), 'Tab wraps around')

    // Ctrl+S writes exactly what the control holds, into the virtual filesystem.
    assert.equal(device.files.exists('doc.txt'), false)
    const saved = device.desktop.keyPress('Ctrl+S')
    assert.equal(saved.detail.saved, true)
    assert.equal(device.files.read('doc.txt'), 'draft')
    assert.equal(device.files.stat('doc.txt').size, 5)
    assert.equal(device.files.stat('doc.txt').mtime, device.clock.now())
    assert.equal(page.query('#saved').text, 'Saved to doc.txt')
    assert.equal(device.files.list('/workspace').length, 1)
    assert.equal(device.files.remove('doc.txt'), true)
    assert.equal(device.files.exists('doc.txt'), false)
    assert.throws(() => device.files.read('doc.txt'), (error) => error.code === CODES.TARGET_NOT_FOUND)

    // The same save through the hotkey port, and a modifier-less hotkey is refused.
    device.desktop.typeText(' again')
    assert.equal(device.desktop.hotkey(['Ctrl', 'S']).detail.saved, true)
    assert.equal(device.files.read('doc.txt'), 'draft again')
    assert.throws(() => device.desktop.hotkey('S'), (error) => error.code === CODES.ACTION_INVALID)

    // Enter submits the form; Escape dismisses a modal.
    const formApp = device.desktop.openApplication({ title: 'Browser', fixture: 'form.html' })
    const formPage = device.page(formApp.detail.pageId)
    device.desktop.click(screenPointOf(formApp.detail, formPage.query('#username')))
    device.desktop.typeText('ada')
    device.desktop.keyPress('Tab')
    device.desktop.typeText('s3cret')
    device.desktop.keyPress('Tab')
    assert.equal(formPage.snapshot().focusedRef, refOf(formPage, '#remember'))
    device.desktop.keyPress('Tab')
    assert.equal(formPage.snapshot().focusedRef, refOf(formPage, '#sign-in'))
    const enter = device.desktop.keyPress('Enter')
    assert.equal(enter.detail.activated, refOf(formPage, '#sign-in'))
    assert.equal(formPage.query('#status').text, 'Saved')

    const modalApp = device.desktop.openApplication({ title: 'Modal', fixture: 'modal.html' })
    const modalPage = device.page(modalApp.detail.pageId)
    device.desktop.click(screenPointOf(modalApp.detail, modalPage.query('#open-modal')))
    assert.equal(modalPage.snapshot().modals.length, 1)
    assert.equal(device.desktop.keyPress('Escape').detail.closedModal !== null, true)
    assert.equal(modalPage.snapshot().modals.length, 0)
  } finally {
    device.dispose()
  }
})

test('mouse motion, drag and scroll report what they hit', () => {
  const device = createDevice()
  try {
    const tall = '<!doctype html><html><head><title>Tall</title></head><body>'
      + '<div style="height:1600px"></div>'
      + '<button id="deep" type="button" style="position:absolute;left:20px;top:1200px">Deep</button></body></html>'
    const app = device.desktop.openApplication({ title: 'Tall', html: tall })
    const page = device.page(app.detail.pageId)
    const moved = device.desktop.moveMouse({ x: 10, y: 40 })
    assert.deepEqual(moved.detail.cursor, { x: 10, y: 40 })
    assert.deepEqual(device.desktop.cursorPosition(), { x: 10, y: 40 })
    const scroll = device.desktop.scroll({ x: 20, y: 100, deltaY: 500 })
    assert.equal(scroll.ok, true)
    assert.equal(scroll.detail.scroll.y, 500)
    // The deep button really moved up with the viewport offset.
    const deepBox = page.query('#deep').bbox
    assert.equal(deepBox.y, 1200 - 500)
    const deepPoint = screenPointOf(app.detail, page.query('#deep'))
    assert.equal(deepPoint.y, app.detail.contentBounds.y + 700 + Math.floor(deepBox.height / 2))
    const drag = device.desktop.drag({ from: deepPoint, to: { x: deepPoint.x + 30, y: deepPoint.y + 10 } })
    assert.equal(drag.ok, true)
    assert.equal(drag.detail.start.hit, 'element')
    assert.equal(drag.detail.start.ref, refOf(page, '#deep'))
    assert.equal(device.desktop.scroll({ x: 1279, y: 799, deltaY: 10 }).detail.reason, 'NO_WINDOW')
    assert.deepEqual(device.desktop.screenMetrics(), DEFAULT_SCREEN)
    assert.throws(() => device.desktop.focusWindow('w404'), (error) => error.code === CODES.TARGET_NOT_FOUND)
  } finally {
    device.dispose()
  }
})

// ----------------------------------------------------------- accessibility ---

test('accessibility invoke really clicks and setValue really writes the DOM', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Browser', fixture: 'form.html' })
    const page = device.page(app.detail.pageId)
    page.typeText('#username', 'ada')
    page.typeText('#password', 's3cret')

    const username = device.accessibility.find({ role: 'textbox', name: 'Username' })
    assert.equal(username.length, 1)
    assert.equal(username[0].focused, false)
    assert.equal(device.accessibility.focus(username[0].ref).ok, true)
    assert.equal(page.snapshot().focusedRef, username[0].ref)
    assert.equal(device.accessibility.value(username[0].ref), 'ada')

    const set = device.accessibility.setValue(username[0].ref, 'grace')
    assert.equal(set.ok, true)
    assert.equal(page.query('#username').value, 'grace')
    assert.equal(device.accessibility.value(username[0].ref), 'grace')

    const signIn = device.accessibility.find({ role: 'button', name: 'Sign in' })
    assert.equal(signIn.length, 1)
    assert.deepEqual(signIn[0].patterns.includes('invoke'), true)
    const invoked = device.accessibility.invoke(signIn[0].ref)
    assert.equal(invoked.detail.action, 'invoke')
    assert.equal(page.query('#status').text, 'Saved', 'invoke must run the real click')

    // Bounds are screen coordinates, so they line up with the desktop driver.
    assert.equal(signIn[0].bounds.y, app.detail.contentBounds.y + page.query('#sign-in').bbox.y)
    // The page-level tree reads the same DOM in document order, including the
    // result nodes a runtime verifies against.
    const pageTree = page.accessibility()
    assert.deepEqual(pageTree.map((node) => node.role), ['textbox', 'textbox', 'checkbox', 'button', 'status', 'alert'])
    assert.equal(pageTree[0].bounds.y, page.query('#username').bbox.y, 'page nodes use viewport coordinates')
    assert.equal(pageTree[0].value, 'grace')
    assert.equal(pageTree[1].value, '', 'the successful submit really cleared the password field')
    assert.equal(pageTree[3].focused, true, 'invoke focuses the control it clicks')
    assert.equal(page.snapshot().focusedRef, signIn[0].ref)
    assert.deepEqual(page.queryAll('form input').map((control) => control.attributes.id), ['username', 'password', 'remember'])
    const root = device.accessibility.root()
    assert.equal(root.role, 'desktop')
    assert.deepEqual(root.bounds, DEFAULT_SCREEN)
    assert.deepEqual(root.children.map((child) => child.role), ['window'])
    assert.equal(root.children[0].handle, app.detail.handle)
    assert.equal(root.children[0].contentBounds.y, TITLE_BAR_HEIGHT)
    assert.ok(device.accessibility.children(root.children[0].ref).some((child) => child.role === 'textbox'))
    assert.equal(device.accessibility.find({ role: 'window', name: 'Browser' }).length, 1)
    assert.equal(device.accessibility.find({ role: 'button', name: /sign/i }).length, 1)
  } finally {
    device.dispose()
  }
})

test('a stale accessibility ref throws TARGET_STALE instead of acting on a guess', () => {
  const device = createDevice()
  try {
    const page = device.openPage('form.html')
    const staleRef = refOf(page, '#sign-in')
    page.navigate('modal.html')
    assert.throws(() => device.accessibility.invoke(staleRef), (error) => error.code === CODES.TARGET_STALE)
    assert.throws(() => device.accessibility.setValue(staleRef, 'x'), (error) => error.code === CODES.TARGET_STALE)
    assert.throws(() => page.clickElement(staleRef), (error) => error.code === CODES.TARGET_STALE)
    assert.throws(() => page.query('e999999'), (error) => error.code === CODES.TARGET_STALE)
    // A modal that is dismissed detaches its nodes, so their refs go stale too.
    page.clickElement('#open-modal')
    const dismiss = refOf(page, '[role="dialog"] button')
    page.clickElement(dismiss)
    assert.throws(() => page.clickElement(dismiss), (error) => error.code === CODES.TARGET_STALE)
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------- screenshot ---

test('captureFull is a real PNG of the virtual screen', () => {
  const device = createDevice()
  try {
    device.desktop.openApplication({ title: 'Browser', fixture: 'form.html' })
    const shot = device.screenshot.captureFull()
    assert.equal(shot.backend, 'device')
    assert.equal(shot.capturedAt, device.clock.now())
    assert.equal(Buffer.isBuffer(shot.png), true, 'the capture is real PNG bytes')
    assert.deepEqual(shot.rect, DEFAULT_SCREEN)
    assert.equal(shot.width, DEFAULT_SCREEN.width)
    assert.equal(shot.height, DEFAULT_SCREEN.height)
    const image = decodeCapture(shot)
    assert.equal(image.width, DEFAULT_SCREEN.width)
    assert.equal(image.height, DEFAULT_SCREEN.height)
    // The desktop is painted where no window is.
    assert.deepEqual(image.pixel(1279, 799), [16, 20, 24])
    // The window frame and title bar are painted from the window's own colour.
    assert.deepEqual(image.pixel(500, 10), [107, 113, 121])
    // Inside the window content the page is drawn: the heading block is its role colour.
    const content = device.desktop.listWindows()[0].contentBounds
    assert.deepEqual(image.pixel(content.x + 2, content.y + 2), [17, 24, 39])
    assert.deepEqual(image.pixel(content.x + 1000, content.y + 4), [17, 24, 39])
  } finally {
    device.dispose()
  }
})

test('a canvas paint is provable from the pixels and clickable only by coordinates', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Checkout', fixture: 'canvas.html' })
    const page = device.page(app.detail.pageId)
    const canvas = page.query('#order')
    assert.equal(canvas.role, 'canvas')
    assert.equal(canvas.name, '', 'nothing about the painted target may leak into the structure')
    assert.equal(page.snapshot().controls.every((control) => control.name !== 'Submit order' || control.tag === 'button'), true)
    assert.equal(page.snapshot().controls.some((control) => control.attributes.id === 'order'), false)

    const shot = device.screenshot.captureFull()
    const image = decodeCapture(shot)
    const content = app.detail.contentBounds
    // The declared paint colour sits exactly on the canvas layout rect.
    assert.deepEqual(image.pixel(content.x + canvas.bbox.x + 1, content.y + canvas.bbox.y + 1), [255, 136, 0])
    assert.deepEqual(image.pixel(content.x + canvas.bbox.x + canvas.bbox.width - 1, content.y + canvas.bbox.y + canvas.bbox.height - 1), [255, 136, 0])

    // Vision is the only route: clicking the painted rect works...
    const painted = device.desktop.click({ x: content.x + canvas.bbox.x + 10, y: content.y + canvas.bbox.y + 10 })
    assert.equal(painted.detail.ref, canvas.ref)
    assert.equal(page.query('#ordered').text, 'Ordered')
    assert.equal(page.query('#wrong').visible, false)

    // ...while the structural decoy leads to the wrong state.
    const decoyPoint = screenPointOf(app.detail, page.query('#decoy'))
    const decoyClick = device.desktop.click(decoyPoint)
    assert.equal(decoyClick.detail.ref, refOf(page, '#decoy'))
    assert.equal(page.query('#wrong').text, 'Wrong target')
  } finally {
    device.dispose()
  }
})

test('captureRegion returns exactly the requested rect and matches the full capture', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Checkout', fixture: 'canvas.html' })
    const page = device.page(app.detail.pageId)
    const canvas = page.query('#order')
    const content = app.detail.contentBounds
    const rect = { x: content.x + canvas.bbox.x, y: content.y + canvas.bbox.y, width: 40, height: 24 }
    const region = device.screenshot.captureRegion(rect)
    assert.deepEqual(region.rect, rect)
    assert.equal(region.width, 40)
    assert.equal(region.height, 24)
    assert.equal(Buffer.isBuffer(region.png), true)
    assert.equal(region.backend, 'device')
    const cropped = decodeCapture(region)
    assert.equal(cropped.width, 40)
    assert.equal(cropped.height, 24)
    assert.deepEqual(cropped.pixel(20, 12), [255, 136, 0])

    const full = decodeCapture(device.screenshot.captureFull())
    for (const point of [[0, 0], [39, 23], [7, 3]]) {
      assert.deepEqual(cropped.pixel(point[0], point[1]), full.pixel(rect.x + point[0], rect.y + point[1]))
    }

    // The page adapter can capture one element or one page rect too.
    const elementShot = page.screenshot({ ref: canvas.ref })
    assert.deepEqual(elementShot.rect, { x: rect.x, y: rect.y, width: canvas.bbox.width, height: canvas.bbox.height })
    assert.deepEqual(decodeCapture(elementShot).pixel(1, 1), [255, 136, 0])
    const pageShot = page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 50 } })
    assert.deepEqual(pageShot.rect, { x: content.x, y: content.y, width: 100, height: 50 })

    const windowShot = device.screenshot.captureWindow(app.detail.handle)
    assert.deepEqual(windowShot.rect, app.detail.bounds)
    assert.equal(windowShot.width, app.detail.bounds.width)
    assert.throws(() => device.screenshot.captureWindow('w404'), (error) => error.code === CODES.TARGET_NOT_FOUND)
  } finally {
    device.dispose()
  }
})

// ------------------------------------------------------------------- device ---

test('the device snapshot reports the whole machine', () => {
  const device = createDevice()
  try {
    const app = device.desktop.openApplication({ title: 'Browser', fixture: 'form.html' })
    device.page(app.detail.pageId).typeText('#username', 'ada')
    const snapshot = device.snapshot()
    assert.equal(snapshot.at, device.clock.now())
    assert.deepEqual(snapshot.screen, DEFAULT_SCREEN)
    assert.equal(snapshot.foregroundWindow, app.detail.handle)
    assert.equal(snapshot.windows.length, 1)
    assert.equal(snapshot.pages.length, 1)
    assert.equal(snapshot.pages[0].controls.find((control) => control.attributes.id === 'username').value, 'ada')
    assert.equal(snapshot.pendingTimers, 0)
    assert.deepEqual(snapshot.clipboard, '')
    assert.deepEqual(device.processes.map((process) => process.windowHandle), [app.detail.handle])
    assert.equal(device.killProcess(device.processes[0].processId).ok, true)
    assert.equal(device.desktop.listWindows().length, 0)
    assert.equal(device.killProcess(4242).detail.reason, 'NO_SUCH_PROCESS')
  } finally {
    device.dispose()
  }
})

test('the same scenario twice produces byte-identical state and pixels', async () => {
  const run = async () => {
    const device = createDevice()
    try {
      const app = device.desktop.openApplication({ title: 'Browser', fixture: 'slow.html' })
      const page = device.page(app.detail.pageId)
      page.clickElement('#slow')
      await page.waitFor({ condition: 'selector', selector: '#slow-result.done', timeoutMs: 5000 })
      page.clickElement('#fast')
      await page.waitFor({ condition: 'selector', selector: '#fast-result.done', timeoutMs: 5000 })
      const shot = device.screenshot.captureFull()
      return {
        at: device.clock.now(),
        revision: page.snapshot().revision,
        // Refs are process-global serials; strip them so two runs are comparable.
        snapshot: JSON.stringify(page.snapshot(), (key, value) => (key === 'ref' || key === 'focusedRef' ? undefined : value)),
        events: device.events.all().map((event) => `${event.at}:${event.type}`),
        png: shot.png
      }
    } finally {
      device.dispose()
    }
  }
  const first = await run()
  const second = await run()
  assert.equal(first.at, 700 + 120)
  assert.equal(first.revision, second.revision)
  assert.equal(first.snapshot, second.snapshot)
  assert.deepEqual(first.events, second.events)
  assert.deepEqual(first.png, second.png)
})

test('dispose stops the device instead of answering from stale state', () => {
  const device = createDevice()
  const page = device.openPage('form.html')
  page.clickElement('#sign-in')
  device.dispose()
  assert.throws(() => device.desktop.listWindows(), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
  assert.throws(() => page.snapshot(), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
  assert.throws(() => device.screenshot.captureFull(), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
  assert.throws(() => device.accessibility.root(), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
  assert.throws(() => device.snapshot(), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
})
