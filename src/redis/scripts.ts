export const LUA_SET_USERNAME = `
local uname_key = KEYS[1]
local uid_uname_key = KEYS[2]
local uid = ARGV[1]
local new_username = ARGV[2]
local new_lower = ARGV[3]

local current_owner = redis.call('GET', uname_key)
if current_owner and current_owner ~= uid then
  return {0, current_owner}
end

local old = redis.call('GET', uid_uname_key)
if old and old ~= new_lower then
  redis.call('DEL', old == 'nil' and '' or (KEYS[1] ~= nil and ''))
end

redis.call('SET', uname_key, uid)
redis.call('SET', uid_uname_key, new_username)
return {1, ''}
`

export const LUA_SUBMIT_SCORE = `
local zkey = KEYS[1]
local uid = ARGV[1]
local score = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = redis.call('ZSCORE', zkey, uid)
local cur_score = tonumber(current) or 0

if score > cur_score then
  redis.call('ZADD', zkey, score, uid)
  redis.call('EXPIRE', zkey, ttl)
  return score
end
return cur_score
`

export const LUA_MERGE_USER = `
local from_uid = ARGV[1]
local to_uid = ARGV[2]

local from_id_key = KEYS[1]
local to_id_key = KEYS[2]

local from_identity = redis.call('GET', from_id_key) or ''
local to_identity = redis.call('GET', to_id_key) or ''

local from_username = redis.call('GET', KEYS[3]) or ''
local to_username = redis.call('GET', KEYS[4]) or ''

local from_uname_key = KEYS[5]
local to_uname_key = KEYS[6]

if from_username ~= '' then
  local current_owner = redis.call('GET', from_uname_key)
  if current_owner == from_uid then
    redis.call('SET', from_uname_key, to_uid)
  end
  redis.call('SET', to_uname_key, from_username)
end

redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[1])

local lb_keys = redis.call('KEYS', KEYS[7])
local merged = 0
for _, key in ipairs(lb_keys) do
  local score = tonumber(redis.call('ZSCORE', key, from_uid)) or 0
  if score > 0 then
    local existing = tonumber(redis.call('ZSCORE', key, to_uid)) or 0
    if score > existing then
      redis.call('ZADD', key, score, to_uid)
    end
    redis.call('ZREM', key, from_uid)
    merged = merged + 1
  end
end
return merged
`
