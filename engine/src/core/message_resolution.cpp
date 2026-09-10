#include "noveltea/core/message_resolution.hpp"

namespace noveltea::core {

std::optional<ResolvedMessage>
MessageResolver::resolve(const MessageResolutionRequest& request) const noexcept
{
    return m_realizer.realize({request.message_id, request.locale});
}

} // namespace noveltea::core
