import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from './ActionButton';
import { theme } from '../lib/theme';

export interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Colours the confirm button red for irreversible actions. */
  destructive?: boolean;
  /** Keeps the sheet open with a spinner while the command row is being written. */
  confirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirming = false,
  onConfirm,
  onCancel,
  testID,
}: ConfirmSheetProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Android back button must resolve the sheet, not the screen behind it.
      onRequestClose={onCancel}
    >
      <View style={styles.root} testID={testID}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${title}`}
          onPress={confirming ? undefined : onCancel}
        />
        <View accessibilityViewIsModal style={styles.sheet}>
          <View style={styles.grabber} />
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {body === undefined ? null : <Text style={styles.body}>{body}</Text>}
          <View style={styles.actions}>
            <ActionButton
              label={cancelLabel}
              variant="secondary"
              onPress={onCancel}
              disabled={confirming}
              fullWidth
            />
            <ActionButton
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              onPress={onConfirm}
              loading={confirming}
              fullWidth
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#00000099',
  },
  sheet: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xxl,
    gap: theme.spacing.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  title: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    color: theme.colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginTop: theme.spacing.md,
  },
});
