local M = {}

function M.before_enter_fault()
  error('Feature Lab BeforeEnter hook failure before Room commit')
end

function M.before_enter_yield()
  audio.play_and_wait('pilot-cue-audio', 'sound-effect')
end

return M
