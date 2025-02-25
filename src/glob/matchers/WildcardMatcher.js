/** @implements {Matcher} */
export class WildcardMatcher {
  /** @type {Matcher[]} */
  children = []

  /**
   * @type {boolean}
   * @readonly
   */
  negating

  /**
   * @param {boolean} negating
   */
  constructor(negating) {
    this.negating = negating
  }

  /**
   * @param {import("../fs/LazyEntry.js").LazyEntry} entry
   * @param {MatchOptions} options
   * @return {MatchResult}
   */
  match(entry, options) {
    // ignore the entry if it's a dotfile and we're not matching dotfiles
    const ignore = entry.name[0] === '.' && !options.dot
    // if we are negating we should always match dotfiles, so we add an exception here
    if (ignore && !this.negating) {
      return 'none'
    }
    return this.children.length === 0 ? 'terminal' : 'partial'
  }
}
