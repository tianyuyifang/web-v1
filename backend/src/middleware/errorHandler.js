const { Prisma } = require('@prisma/client');

function errorHandler(err, req, res, next) {
  // Prisma unique constraint violation
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(409).json({
      error: { message: 'Resource already exists', status: 409 },
    });
  }

  // Prisma record not found
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    return res.status(404).json({
      error: { message: 'Resource not found', status: 404 },
    });
  }

  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  const response = {
    error: { message, status: statusCode },
  };

  // A machine-readable code, when the error carries one, so the client can
  // branch on the case rather than string-matching the message. Only set on
  // operational errors that opt in (e.g. ACCOUNT_DISABLED at login); ordinary
  // errors have no code and the field is simply absent.
  if (err.isOperational && err.code) {
    response.error.code = err.code;
  }

  if (err.details) {
    response.error.details = err.details;
  }

  if (process.env.NODE_ENV !== 'production' && !err.isOperational) {
    response.error.stack = err.stack;
  }

  if (statusCode === 500) {
    console.error('Unhandled error:', err);
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
