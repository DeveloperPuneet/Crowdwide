const mongoose = require('mongoose');

// One row per search a member runs. Used only to work out which queries are
// popular right now, so rows expire on their own after 45 days.
const searchEventSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true }, // normalized query (lowercase, single spaces)
  label: { type: String, required: true, maxlength: 80 }, // how it is displayed
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  hits: { type: Number, default: 0 }, // results found, so dead-end searches are never "popular"
  createdAt: { type: Date, default: Date.now, expires: 45 * 24 * 60 * 60 }
});

searchEventSchema.index({ createdAt: -1, key: 1 });

module.exports = mongoose.model('SearchEvent', searchEventSchema);
