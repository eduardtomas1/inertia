import { z } from "zod";

export const PRIVATE_CONNECT_QUESTION_LIMITS = Object.freeze({
  questions: 32,
  options: 32,
  identifierCharacters: 200,
  labelCharacters: 240,
  answerValues: 32,
  answerCharacters: 2_000,
  totalAnswerCharacters: 8_000,
});

const questionIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(PRIVATE_CONNECT_QUESTION_LIMITS.identifierCharacters);
const questionLabel = z.string().max(PRIVATE_CONNECT_QUESTION_LIMITS.labelCharacters);

export const privateConnectSafeQuestionSchema = z.object({
  id: questionIdentifier,
  label: questionLabel,
  options: z.array(z.object({
    id: questionIdentifier,
    label: questionLabel,
  }).strict()).max(PRIVATE_CONNECT_QUESTION_LIMITS.options),
  allowMultiple: z.boolean(),
  allowCustomAnswer: z.boolean(),
}).strict();
export type PrivateConnectSafeQuestion = z.infer<
  typeof privateConnectSafeQuestionSchema
>;

export const privateConnectSafeQuestionsSchema = z
  .array(privateConnectSafeQuestionSchema)
  .max(PRIVATE_CONNECT_QUESTION_LIMITS.questions);

export const privateConnectQuestionAnswersSchema = z
  .record(
    questionIdentifier,
    z.array(
      z.string().min(1).max(PRIVATE_CONNECT_QUESTION_LIMITS.answerCharacters),
    ).min(1).max(PRIVATE_CONNECT_QUESTION_LIMITS.answerValues),
  )
  .refine(
    (value) => Object.keys(value).length <= PRIVATE_CONNECT_QUESTION_LIMITS.questions,
    { message: "Too many answered questions." },
  )
  .refine(
    (value) => Object.values(value)
      .reduce(
        (total, values) => total + values.reduce((sum, answer) => sum + answer.length, 0),
        0,
      ) <= PRIVATE_CONNECT_QUESTION_LIMITS.totalAnswerCharacters,
    { message: "The answers were too large." },
  );
export type PrivateConnectQuestionAnswers = z.infer<
  typeof privateConnectQuestionAnswersSchema
>;
