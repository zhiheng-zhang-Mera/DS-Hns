'use strict'

/**
 * The system orb's bridge (`app/extensions/mega/system-orb.cjs`).
 *
 * A window of ours, so the same rule the dock's preload follows applies here: **this file is the whole
 * reachable surface** of that window. It can ask for the current state, say what happened, ask for one of
 * the governance actions, and schedule a task — and nothing else. There is no channel that takes a path, a
 * command or a function, and no dynamic channel name, so the surface can be enumerated rather than guessed at.
 *
 * The last two are the timing pair the ball's own new-task form uses. They are two named channels rather than one
 * that takes an arbitrary request, for the reason the governance actions are a closed set: a window that can ask
 * for "anything" is a window that has to be trusted with everything.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hnsOrb', {
  /** The current state, for the first paint (the updates arrive through `onState`). */
  snapshot: () => ipcRenderer.invoke('mega:orb-snapshot'),
  /** Open or close the panel. The shell decides how big the window has to become. */
  open: (value) => ipcRenderer.invoke('mega:orb-open', value === true),
  /** What the panel measured, so the shell can grow the window to fit it. */
  measure: (size) => ipcRenderer.invoke('mega:orb-measure', size),
  /** Press / move / release. Screen coordinates: the window is moved to follow them. */
  drag: (phase, point) => ipcRenderer.invoke('mega:orb-drag', { phase: String(phase), point }),
  /** Whether the cursor is over something clickable — that is what makes the window interactive. */
  hover: (over) => ipcRenderer.invoke('mega:orb-hover', over === true),
  /** One of the governance actions the closed set allows. */
  action: (action, id) => ipcRenderer.invoke('mega:orb-action', { action, id }),
  /** What a scheduled task may be: the same answer the official dialog gets, from the same bridge. */
  timing: () => ipcRenderer.invoke('mega:orb-timing'),
  /** Schedule one task — the same `scheduler.addTask` the dialog and the dock's form use. */
  createTask: (input) => ipcRenderer.invoke('mega:orb-task', input || {}),
  /** Every state change, pushed by the shell. */
  onState: (callback) => ipcRenderer.on('mega:orb-state', (_event, payload) => callback(payload))
})
