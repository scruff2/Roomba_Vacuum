#include "sseparser.h"

QList<SseParser::Event> SseParser::feed(const QByteArray &chunk)
{
    QList<Event> events;
    m_buffer += chunk;
    qsizetype newline;
    while ((newline = m_buffer.indexOf('\n')) >= 0) {
        QByteArray line = m_buffer.left(newline);
        m_buffer.remove(0, newline + 1);
        if (line.endsWith('\r'))
            line.chop(1);

        if (line.isEmpty()) {
            // A blank line ends the event; comments-only blocks have no data.
            if (!m_data.isEmpty())
                events.append({m_name.isEmpty() ? QStringLiteral("message") : m_name, m_data});
            m_name.clear();
            m_data.clear();
        } else if (line.startsWith(':')) {
            continue; // keep-alive comment
        } else if (line.startsWith("event:")) {
            m_name = QString::fromUtf8(line.mid(6).trimmed());
        } else if (line.startsWith("data:")) {
            if (!m_data.isEmpty())
                m_data += '\n';
            QByteArray value = line.mid(5);
            if (value.startsWith(' '))
                value.remove(0, 1);
            m_data += value;
        }
    }
    return events;
}

void SseParser::reset()
{
    m_buffer.clear();
    m_name.clear();
    m_data.clear();
}
