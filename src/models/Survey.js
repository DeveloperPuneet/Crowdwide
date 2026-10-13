const mongoose = require('mongoose');

// A survey is a list of poll-style questions (one answer per question).
//
// `epoch` is bumped every time the admin clears the results. Responses are
// stamped with the epoch they were collected in, so "clear" is a single atomic
// increment: anything from an older epoch is invisible immediately and is then
// deleted. It is also what lets a browser that already answered see the survey
// again after a clear.
const optionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 150 }
});

const questionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  options: { type: [optionSchema], validate: [(value) => value.length >= 2 && value.length <= 10, 'A question needs 2 to 10 options.'] }
});

const surveySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  // draft: only visible to admins · published: open to everyone · closed: visible but no new answers
  status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft', index: true },
  questions: { type: [questionSchema], validate: [(value) => value.length >= 1 && value.length <= 30, 'A survey needs 1 to 30 questions.'] },
  epoch: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

surveySchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Survey', surveySchema);
