// Question of the Day: a small, rotating set of open, friendly questions anyone
// can answer in a sentence or two. One per calendar day (UTC), the same for
// everybody, so people can see and answer the same thing together. Answers are
// ordinary public posts tagged #qotd.
const QUESTIONS = [
  'What is a small thing that made your week better?',
  'What is one skill you wish you had learned earlier?',
  'What is the best piece of advice you have ever been given?',
  'Which book, film or show changed how you think?',
  'What are you building, learning or making right now?',
  'What is a tool or app you cannot work without?',
  'What did you believe five years ago that you no longer do?',
  'What is a hidden gem in your city that visitors miss?',
  'What does your ideal Sunday look like?',
  'Which mistake taught you the most?',
  'What is something you are proud of that nobody knows about?',
  'What is a habit that quietly improved your life?',
  'If you could master any craft overnight, which would it be?',
  'What is the most useful thing you learned this month?',
  'Which community, online or offline, feels most like home to you?',
  'What would you teach a total beginner in your field on day one?',
  'What is a question you wish more people asked?',
  'What song, album or playlist is on repeat for you lately?',
  'What is the kindest thing a stranger has done for you?',
  'What is one thing you would automate if you could?',
  'What is your favourite way to learn something new?',
  'What topic could you talk about for hours?',
  'What is a food or dish that reminds you of home?',
  'What is a small risk that paid off for you?',
  'What is a belief you hold that most people disagree with?',
  'What does a good day of work look like for you?',
  'Which place would you go back to in a heartbeat?',
  'What is something you are curious about but have not started yet?',
  'Who taught you something important, and what was it?',
  'What would you build if you had one free month?',
  'What is the most underrated thing in your field?',
  'What is a rule you set for yourself that actually works?',
  'What is a project you abandoned and still think about?',
  'What is the best thing you have read or watched this week?',
  'What is one thing you wish your younger self knew?',
  'What is your favourite local tradition or festival?',
  'What is a skill you use every day that nobody taught you?',
  'What is something simple that you find deeply satisfying?',
  'What did you do this week that you would do again?',
  'What is a goal you are quietly working towards?',
  'What is an everyday object you think is perfectly designed?',
  'What question are you stuck on and would love a fresh view about?',
  'If you could start a community about anything, what would it be?',
  'What is the best free resource you have ever found?',
  'What is something you changed your mind about recently?',
  'What is a story from your life that always makes people laugh?',
  'What is your go-to way to reset after a rough day?',
  'What is one thing about your culture you would love to share?',
  'Which day-to-day problem do you wish someone would solve?',
  'What are you grateful for today?'
];

const DAY_MS = 24 * 60 * 60 * 1000;
const QUESTION_TAG = 'qotd';

function dayNumber(date = new Date()) {
  return Math.floor(new Date(date).getTime() / DAY_MS);
}

function startOfDay(date = new Date()) {
  return new Date(dayNumber(date) * DAY_MS);
}

function questionOfTheDay(date = new Date()) {
  const day = dayNumber(date);
  return { index: day % QUESTIONS.length, text: QUESTIONS[day % QUESTIONS.length], tag: QUESTION_TAG, day };
}

// Text dropped into the composer when someone taps "Answer".
function answerPrefill(question) {
  return `${question.text}\n\n#${question.tag}`;
}

module.exports = { QUESTIONS, QUESTION_TAG, questionOfTheDay, answerPrefill, startOfDay };
