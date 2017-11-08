'use strict'

const { List, FixedQueue } = require('./data-structures')

function arrayEntries(array) {
  let i = -1
  const length = array.length
  const entries = []
  while (++i < length) {
    const val = array[i]
    entries[entries.length] = [i, val]
  }
  return entries
}

/*
  Three possible states:

  OPEN   : The Channel can be written to and taken from freely.
  CLOSED : The Channel can no longer be written to, but still has values to be taken.
  ENDED  : The Channel is closed, and no longer has values to be taken.
*/
const STATES = {
  OPEN: Symbol('channel_open'),
  CLOSED: Symbol('channel_closed'),
  ENDED: Symbol('channel_ended'),
}

const ACTIONS = {
  // channel has just been closed, and has no more values to take
  DONE: Symbol('channel_done'),
  CANCEL: Symbol('channel_cancel'),
}

const SLIDER = Symbol('channel_slider')
const STATE = Symbol('channel_state')
const SHOULD_CLOSE = Symbol('channel_should_close')
const IS_CONSUMING = Symbol('channel_consuming')
const IS_FLUSHING = Symbol('channel_flushing')
const IS_SLIDING = Symbol('channel_sliding')

/*
  Error expose method to assist with ensuring
  that error messages are properly thrown instead of swallowed.

  setTimeout is used to ensure that the error is thrown
  from a location that will not be eaten by an async throw.
*/
function expose(e) {
  setTimeout(() => {
    throw e
  })
}

/*
  Marks a channel as ended, and signals any promises
  which are waiting for the end of the channel.
*/
function finish(ch) {
  ch[STATE] = STATES.ENDED
  let waiting = null
  while (
    (waiting = ch.waiting.shift()) // eslint-disable-line no-cond-assign
  ) {
    waiting()
  }
}

/*
  Flushes out any remaining takes from the channel
  by sending them the value of `ACTIONS.DONE`.
*/
async function flush(ch) {
  if (!ch.empty())
    // this error is never expected to be thrown
    // just a sanity check during development
    throw new Error(
      'Attempted to execute flush(Channel) on a non-empty channel!',
    )
  if (ch[IS_FLUSHING]) return
  ch[IS_FLUSHING] = true
  let take = null
  const takes = []
  while (
    (take = ch.takes.shift()) // eslint-disable-line no-cond-assign
  ) {
    takes.push(take(ACTIONS.DONE))
  }
  await Promise.all(takes)
  if (!ch[IS_CONSUMING]) finish(ch)
  ch[IS_FLUSHING] = false
}

function wrap(val, transform, resolve) {
  let wrapped = null
  if (transform instanceof Function) {
    if (transform.length === 1) {
      wrapped = async () => {
        const transformed = transform(val)
        if (transformed instanceof Promise) {
          const actual = await transformed
          return actual
        }
        return transformed
      }
    } else {
      const accepted = new List()
      if (transform.length === 2) {
        wrapped = async () => {
          await transform(val, acc => {
            if (typeof acc !== 'undefined') accepted.push(acc)
          })
          return accepted
        }
      } else {
        /* transform.length === 3 */ wrapped = () => {
          return new Promise(res => {
            transform(
              val,
              acc => {
                if (typeof acc !== 'undefined') accepted.push(acc)
              },
              () => {
                res(accepted)
              },
            )
          })
        }
      }
    }
  } else {
    wrapped = async () => val
  }
  return {
    wrapped,
    resolve,
    transform,
    val,
  }
}

async function _bufferedSlide(ch) {
  while (!ch.buf.empty() && !ch.takes.empty()) {
    const buf = ch.buf.shift()
    let val = null
    if (buf && buf.wrapped) val = await buf.wrapped()
    else val = buf // this is a special case caused by `from`. can we get rid of the need for this?
    if (typeof val !== 'undefined') {
      if (val instanceof List) {
        // need a way to distinguish this as a "special" array return
        const accepted = [...val]
        if (accepted.length === 0) buf.resolve()
        else if (accepted.length === 1) {
          buf.resolve()
          const take = ch.takes.shift()
          take(accepted[0])
        } else {
          /* accepted.length > 1 */ let count = 0
          const counter = () => {
            count++
            if (count === accepted.length) buf.resolve()
          }
          const wrappers = accepted.map(acc => wrap(acc, x => x, counter))
          // when we use counter as the resolve, it makes us need
          // to call buf.resolve(), whereas we wouldn't normally,
          // since resolve() should have been called when moving
          // from put -> buf.

          // the problem is that when we use these expanded wrappers,
          // we need to execute the resolution. if we place on the buffer
          // directly, we can be sure we maintain the correct order.
          // if we place back on puts instead of the buffer,
          // we may or may not have the right order anymore.

          // another issue is what if we accept more than the buffer has space for?
          // what if there were already items on the buffer? do we kick them out,
          // and put them back in puts? that gives us essentially the same problem --
          // then we would have puts which don't need put.resolve() to be called,
          // which doesn't follow the usual pattern.

          // what to do, what to do... try to hammer out the inconsistency at some point.

          ch.buf.unshift(...wrappers) // this can expand beyond the actual buffer size. unintuitive?
        }
      } else {
        const take = ch.takes.shift()
        take(val)
      }
    }
  }
  while (!ch.puts.empty() && !ch.buf.full()) {
    const put = ch.puts.shift()
    ch.buf.push(put)
    put.resolve()
  }
}

async function _slide(ch) {
  while (!ch.takes.empty() && !ch.puts.empty()) {
    const put = ch.puts.shift()
    const val = await put.wrapped()
    if (typeof val !== 'undefined') {
      if (val instanceof List) {
        // need a way to distinguish this as a "special" array return
        const accepted = [...val]
        if (accepted.length === 0) put.resolve()
        else if (accepted.length === 1) {
          put.resolve()
          const take = ch.takes.shift()
          take(accepted[0])
        } else {
          /* val.length > 1 */ let count = 0
          const counter = () => {
            count++
            if (count === accepted.length) put.resolve()
          }
          const wrappers = accepted.map(acc => wrap(acc, x => x, counter))
          ch.puts.unshift(...wrappers)
        }
      } else {
        put.resolve()
        const take = ch.takes.shift()
        take(val)
      }
    } else {
      put.resolve()
    }
  }
}

function canSlide(ch) {
  return ch.buf
    ? (!ch.buf.full() && !ch.puts.empty()) ||
        (!ch.takes.empty() && !ch.buf.empty())
    : !ch.takes.empty() && !ch.puts.empty()
}

async function slide(ch) {
  if (ch[IS_SLIDING]) return
  ch[IS_SLIDING] = true

  while (canSlide(ch)) await ch[SLIDER](ch)

  if (
    ch[STATE] === STATES.CLOSED &&
    !ch.tails.empty() &&
    (ch.buf ? ch.buf.empty() : true) &&
    ch.puts.empty()
  ) {
    ch.puts.unshift(...ch.tails)
    ch.tails = new List() // need a way to empty out the list
    while (canSlide(ch)) await ch[SLIDER](ch)
  }

  if (
    (ch[STATE] === STATES.CLOSED || ch[STATE] === STATES.ENDED) &&
    (ch.buf ? ch.buf.empty() : true) &&
    ch.puts.empty() &&
    ch.tails.empty()
  )
    flush(ch)

  ch[IS_SLIDING] = false
}

function timeout(delay = 0) {
  return new Promise(resolve => {
    setTimeout(resolve, delay)
  })
}

class Channel {
  /*
    Default constructor for a Channel.

    Accepts an optional size for the internal buffer,
    and an optional transform function to be used by the Channel.

    Examples:
      new Channel()              -> Non buffered channel, no transform
      new Channel(x => x * 2)    -> Non buffered channel, with transform
      new Channel(8)             -> Buffered channel, no transform
      new Channel(8, x => x * 2) -> Buffered channel, with transform
  */
  constructor(...argv) {
    // A List containing any puts which could not be placed directly onto the buffer
    this.puts = new List()

    // A List containing any puts to be appended to the end of the channel
    this.tails = new List()

    // A List containing any takes waiting for values to be provided
    this.takes = new List()

    // A FixedQueue containing values ready to be taken.
    this.buf = null

    // An optional function to used to transform values passing through the channel.
    this.transform = null

    // An optional pipeline of channels, to be used to pipe values
    // from one channel to multiple others.
    this.pipeline = []

    // An optional array of promises, to be resolved when the channel is marked as finished.
    this.waiting = []

    let size = null
    let transform = null
    let buffer = null
    if (typeof argv[0] === 'function') transform = argv[0]
    if (typeof argv[0] === 'number') {
      size = argv[0]
      if (argv[1] && typeof argv[1] === 'function') transform = argv[1]
    }
    if (typeof argv[0] === 'object') {
      // assume first arg is buffer type
      // consider adding some duck-type or instanceof safety
      buffer = argv[0]
      if (argv[1] && typeof argv[1] === 'function') transform = argv[1]
    }
    this.transform = transform
    this[STATE] = STATES.OPEN

    if (size) {
      this.buf = new FixedQueue(size)
      this[SLIDER] = _bufferedSlide
    } else if (buffer) {
      this.buf = buffer
      this[SLIDER] = _bufferedSlide
    } else this[SLIDER] = _slide
  }

  /*
    A helper constructor which will convert any iterable into a channel,
    placing all of the iterable's values onto that channel.
  */
  static from(iterable, keepOpen = false) {
    const arr = [...iterable]
    const ch = new Channel(arr.length)
    for (const val of arr) ch.buf.push(val)
    if (!keepOpen) ch.close(true)
    return ch
  }

  /*
    Sets the state of the channel.
  */
  set state(val) {
    this[STATE] = val
  }

  /*
    Gets the state of the channel.
  */
  get state() {
    return this[STATE]
  }

  /*
    Gets the length of the channel,
    which is interpreted as the current length of the buffer
    added to any puts which are waiting for space in the buffer.
  */
  get length() {
    if (this.buf) return this.buf.length + this.puts.length
    return this.puts.length
  }

  /*
    Gets the size of the channel,
    which is interpreted as the size of the buffer.
  */
  get size() {
    return this.buf ? this.buf.size : undefined
  }

  /*
    Marks a channel to no longer be writable.

    Accepts an optional boolean `all`, to signify
    whether or not to close the entire pipeline.
  */
  static close(ch, all = false) {
    ch.state = STATES.CLOSED
    if (all) ch[SHOULD_CLOSE] = true
    setTimeout(() => slide(ch)) // we have a timing problem with pipes.. this resolves it, but is hacky.
  }

  /*
    Calls Channel.close for `this`, `all`.
  */
  close(all = false) {
    return Channel.close(this, all)
  }

  /*
    Determines if a channel
    has any values left for `take` to use.
  */
  static empty(ch) {
    if (ch.buf) return ch.buf.empty() && ch.puts.empty()
    return ch.puts.empty()
  }

  /*
    Returns Channel.empty for `this`.
  */
  empty() {
    return Channel.empty(this)
  }

  /*
    Places a new value onto the provided channel.

    If the buffer is full, the promise will be pushed
    onto Channel.puts to be resolved when buffer space is available.
  */
  static put(ch, val) {
    return new Promise(resolve => {
      if (ch.state !== STATES.OPEN) return resolve(ACTIONS.DONE)
      const put = wrap(val, ch.transform, resolve)
      ch.puts.push(put)
      slide(ch)
    })
  }

  /*
    Returns Channel.put for `this`, `val`.
  */
  put(val) {
    return Channel.put(this, val)
  }

  /*
    Takes the first value from the provided channel.

    If no value is provided, the promise will be pushed
    onto Channel.takes to be resolved when a value is available.
  */
  static take(ch) {
    return new Promise(resolve => {
      if (ch.state === STATES.ENDED) return resolve(ACTIONS.DONE)
      ch.takes.push(resolve)
      slide(ch)
    })
  }

  /*
    Returns Channel.take for `this`.
  */
  take() {
    return Channel.take(this)
  }

  static tail(ch, val) {
    return new Promise(resolve => {
      if (ch.state !== STATES.OPEN) return resolve(ACTIONS.DONE)
      const tail = wrap(val, ch.transform, resolve)
      ch.tails.push(tail)
      slide(ch)
    })
  }

  /*
    Returns Channel.tail for `this`.
  */
  tail(val) {
    return Channel.tail(this, val)
  }

  /*
    Helper method for putting values onto a channel
    from a provided producer whenever there is space.
  */
  static async produce(ch, producer) {
    let spin = true
    ;(async () => {
      try {
        while (spin) {
          let val = producer()
          if (val instanceof Promise) val = await val
          else await timeout()
          const r = await Channel.put(ch, val)
          if (r === ACTIONS.DONE) break
        }
      } catch (e) {
        expose(e)
      }
    })()
    return () => {
      spin = false
    }
  }

  /*
    Calls Channel.produce for `this`, `producer`.
  */
  produce(producer) {
    return Channel.produce(this, producer)
  }

  /*
    Helper method for executing a provided consumer
    each time a channel value is available.
  */
  static async consume(ch, consumer = () => {}) {
    ch[IS_CONSUMING] = true
    ;(async () => {
      let taking = Channel.take(ch)
      while (ch[IS_CONSUMING]) {
        const val = await taking
        if (val === ACTIONS.DONE) break
        const consuming = consumer(val)
        taking = Channel.take(ch)
        await consuming
      }
      ch[IS_CONSUMING] = false
      if (ch[IS_FLUSHING]) await ch[IS_FLUSHING]
      else finish(ch)
    })()
  }

  /*
    Calls Channel.consume for `this`, `consumer`.
  */
  consume(consumer = () => {}) {
    return Channel.consume(this, consumer)
  }

  /*
    Registers a promise to be resolved
    when the channel has fully ended.
  */
  static done(ch) {
    return new Promise(resolve => {
      if (ch.state === STATES.ENDED) return resolve()
      ch.waiting.push(resolve)
    })
  }

  /*
    Returns Channel.done for `this`.
  */
  done() {
    return Channel.done(this)
  }

  /*
    Automatically builds a set of channels
    for the provided function arguments,
    setting up a pipe from the first channel
    all the way down to the last channel.

    Returns references to both
    the first and the last channel.
  */
  static pipeline(...args) {
    let first = null
    let last = null
    if (args.length === 0) {
      first = new Channel()
      last = first
    } else {
      if (Array.isArray(args[0])) args = [...args[0]]
      const channels = args
        .filter(x => x instanceof Function || x instanceof Channel)
        .map(x => (x instanceof Channel ? x : new Channel(x)))
      first = channels[0]
      last = channels.reduce((x, y) => x.pipe(y))
    }
    return [first, last]
  }

  /*
    Builds a pipeline from a parent channel
    to one or more children.

    This will automatically pipe values from
    the parent onto each of the children.

    (dev note: careful, errors which are thrown from here
      do NOT bubble up to the user yet in nodejs.
      will be fixed in the future, supposedly).
  */
  static pipe(parent, ...channels) {
    channels = channels.map(x => (x instanceof Function ? new Channel(x) : x))
    parent.pipeline.push(...channels)
    if (!parent[ACTIONS.CANCEL]) {
      let running = true
      ;(async () => {
        while (running) {
          const val = await parent.take()
          if (val === ACTIONS.DONE) {
            if (parent[SHOULD_CLOSE]) {
              for (const channel of parent.pipeline) channel.close(true)
            }
            break
          }
          await Promise.all(parent.pipeline.map(x => x.put(val))) // eslint-disable-line no-loop-func
        }
      })()
      parent[ACTIONS.CANCEL] = () => {
        running = false
      }
    }
    return channels[channels.length - 1]
  }

  /*
    Returns Channel.pipe for `this`, `...channels`.
  */
  pipe(...channels) {
    return Channel.pipe(this, ...channels)
  }

  /*
    Pipes all provided channels into a new, single destination.
  */
  static merge(...channels) {
    const child = new Channel()
    for (const parent of channels) parent.pipe(child)
    return child
  }

  /*
    Returns Channel.merge for `this`, `...channels`.
  */
  merge(...channels) {
    return Channel.merge(this, ...channels)
  }

  static unpipe(parent, ...channels) {
    for (const [index, pipe] of arrayEntries(parent.pipeline)) {
      for (const ch2 of channels) {
        if (pipe === ch2) parent.pipeline.splice(index, 1)
      }
    }
    if (parent.pipeline.length === 0 && parent[ACTIONS.CANCEL])
      parent[ACTIONS.CANCEL]() // don't spin the automatic pipe method when no pipeline is attached
    return parent
  }

  unpipe(...channels) {
    return Channel.unpipe(this, ...channels)
  }

  map(mapper) {
    const target = new Channel()
    ;(async () => {
      while (true) {
        const val = await this.take()
        if (val === ACTIONS.DONE) {
          target.close()
          break
        }
        const mapped = await mapper(val) // need try/catch/error out the channel
        await target.put(mapped)
      }
    })()
    return target
  }

  async toArray() {
    const arr = []
    while (true) {
      const val = await this.take()
      if (val === ACTIONS.DONE) {
        break
      }
      arr[arr.length] = val
    }
    return arr
  }
}

Channel.DONE = ACTIONS.DONE // expose this so loops can listen for it

module.exports = {
  default: Channel,
  Channel,
  timeout,
  STATES,
  ACTIONS,
}
