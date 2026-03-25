/**
 * Zod validation middleware factory.
 * Usage: router.post('/', validate(schema), handler)
 *
 * Validates req.body against the schema. On success, attaches
 * parsed data to req.validated. On failure, returns 400 with field errors.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: {
          message: 'Validation failed',
          status: 400,
          details: result.error.flatten().fieldErrors,
        },
      });
    }
    req.validated = result.data;
    next();
  };
}

module.exports = validate;
