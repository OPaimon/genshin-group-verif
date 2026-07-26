// ioredis-mock ships no type declarations; it emulates the ioredis API,
// which is exactly how the store consumes it.
declare module 'ioredis-mock' {
    import type { Redis } from 'ioredis'

    const RedisMock: new () => Redis
    export default RedisMock
}
