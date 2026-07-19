(() => {
  "use strict";
  // The enhanced clock owns the reset transaction. Keeping this compatibility
  // file side-effect free prevents a later script from replacing its confirmed,
  // cancellable reset handler or dropping session fields from persisted state.
})();
