#pragma once

#include <QByteArray>
#include <QList>
#include <QString>

// Splits a Server-Sent Events byte stream into events. Network reads can end
// anywhere, mid-line or mid-event, so it buffers until a blank line closes
// an event.
class SseParser {
public:
    struct Event {
        QString name;
        QByteArray data;
    };

    QList<Event> feed(const QByteArray &chunk);
    void reset();

private:
    QByteArray m_buffer;
    QString m_name;
    QByteArray m_data;
};
