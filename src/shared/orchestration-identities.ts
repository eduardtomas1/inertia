import { z } from "zod";

export const orchestrationIdSchema = z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/u);
