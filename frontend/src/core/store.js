/**
 * The storage adapter.
 *
 * One singleton for the whole app: swapping LocalStore for ApiStore (a
 * backend) is a one-line change here and nothing else.
 */
import { LocalStore } from '../storage.js';

export const store = new LocalStore();
