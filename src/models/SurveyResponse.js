const mongoose = require('mongoose');

// One submitted survey. This is deliberately anonymous: there is no user,
// email, name, IP address, session or user-agent field and no timestamps -
// only which option was picked for each question.
const surveyResponseSchema = new mongoose.Schema({
  survey: { type: mongoose.Schema.Types.ObjectId, ref: 'Survey', required: true },
  epoch: { type: Number, required: true, default: 0 },
  answers: [{
    _id: false,
    question: { type: mongoose.Schema.Types.ObjectId, required: true },
    option: { type: mongoose.Schema.Types.ObjectId, required: true }
  }]
}, { timestamps: false, versionKey: false });

surveyResponseSchema.index({ survey: 1, epoch: 1 });

module.exports = mongoose.model('SurveyResponse', surveyResponseSchema);
