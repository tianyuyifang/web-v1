const { z } = require('zod');

const registerSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[\u4e00-\u9fffa-zA-Z0-9_]+$/, 'Username can only contain Chinese characters, letters, numbers, and underscores'),
  password: z.string().min(8),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const changeUsernameSchema = z.object({
  newUsername: z.string().min(2).max(30).regex(/^[\u4e00-\u9fffa-zA-Z0-9_]+$/, 'Username can only contain Chinese characters, letters, numbers, and underscores'),
  currentPassword: z.string().min(1),
});

const updatePreferencesSchema = z.object({
  preferences: z.object({
    language: z.enum(['zh', 'en']).optional(),
    theme: z.enum(['dark', 'light', 'high-contrast']).optional(),
  }),
});

module.exports = { registerSchema, loginSchema, changePasswordSchema, changeUsernameSchema, updatePreferencesSchema };
