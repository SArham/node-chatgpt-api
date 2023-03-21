#!/usr/bin/env node
/* eslint-disable import/first */
/* eslint-disable import/no-extraneous-dependencies */
// eslint-disable-next-line no-unused-vars
import dotenv from 'dotenv';
import fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyAuth from '@fastify/auth';
import { FastifySSEPlugin } from '@waylaidwanderer/fastify-sse-v2';
// server.js

dotenv.config();

import userRoutes from '../src/utils/authentication-strategies.js';

const server = fastify();

await server.register(FastifySSEPlugin);
await server.register(fastifyAuth);
await server.register(cors, {
    origin: '*',
});

await server.register(userRoutes);

server.listen({
    port: 3000,
    host: 'localhost',
}, (error) => {
    if (error) {
        console.error(error);
        process.exit(1);
    }
});
