language_board = {}
function language_board.count(document)
  local count = assert(Game.prop('story-count')) + 1
  assert(Game.set_prop('story-count', count))
  local result = Text.msg('lab.letters', {count=count, kind=count == 2 and 'sealed' or 'open', amount=1234.5})
  local binding = document:GetElementById('language-result')
  binding:SetAttribute('arg-count', tostring(count))
  binding:SetAttribute('arg-kind', count == 2 and 'sealed' or 'open')
  noveltea.notify(result)
end
