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
