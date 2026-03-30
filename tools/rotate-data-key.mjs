#!/usr/bin/env node
import { rotateChatroomKeysEncryptionSync } from '../chatroomStorage.js';

const result = rotateChatroomKeysEncryptionSync();
console.log(JSON.stringify({ ok: true, ...result }));
